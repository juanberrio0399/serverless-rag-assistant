// Conversation memory against Miniflare's local D1 (migrations applied in apply-migrations.js).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { LLM_MODEL } from "../../src/index.js";
import { EMBED_MODEL } from "../../src/ingest.js";
import { MAX_MEMORY_CHARS, MAX_MESSAGES, RETENTION_DAYS } from "../../src/memory.js";

let ipCounter = 0;
const ask = (body) =>
  new Request("https://rag.example/ask", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `192.0.2.${++ipCounter}` },
    body: JSON.stringify(body),
  });

async function callWorker(request, bindings = env) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx); // the turn is saved in ctx.waitUntil
  return response.json();
}

const rows = async (conversationId) =>
  (await env.DB.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id").bind(conversationId).all()).results;

let llmInputs;
let embedInputs;
beforeEach(() => {
  llmInputs = [];
  embedInputs = [];
  vi.spyOn(env.AI, "run").mockImplementation(async (model, input) => {
    if (model === EMBED_MODEL) { embedInputs.push(input.text[0]); return { data: [[0.1, 0.2]] }; }
    if (model.includes("reranker")) return { response: [{ id: 0, score: 0.9 }] };
    if (model === LLM_MODEL) { llmInputs.push(input); return { response: `Answer ${llmInputs.length}.` }; }
    throw new Error(`unexpected model ${model}`);
  });
  vi.spyOn(env.VECTORIZE, "query").mockResolvedValue({
    matches: [{ score: 0.8, metadata: { text: "DataForge runs every day at 6am.", source: "profile" } }],
  });
});
afterEach(() => vi.restoreAllMocks());

describe("conversation memory (D1)", () => {
  it("creates a conversationId and stores the turn without request metadata", async () => {
    const data = await callWorker(ask({ question: "How often does DataForge run?" }));
    expect(data.answer).toBe("Answer 1.");
    expect(data.conversationId).toMatch(/^[0-9a-f-]{36}$/);

    const stored = await rows(data.conversationId);
    expect(stored.map((r) => [r.role, r.content])).toEqual([
      ["user", "How often does DataForge run?"],
      ["assistant", "Answer 1."],
    ]);
    const columns = (await env.DB.prepare("PRAGMA table_info(messages)").all()).results.map((c) => c.name);
    expect(columns).toEqual(["id", "conversation_id", "role", "content", "created_at"]);
  });

  it("sends earlier turns to the model and uses the previous question for retrieval", async () => {
    const conversationId = "follow-up-test-1";
    await callWorker(ask({ question: "What is DataForge?", conversationId }));
    const data = await callWorker(ask({ question: "How often does it run?", conversationId }));

    expect(data.conversationId).toBe(conversationId);
    const messages = llmInputs[1].messages;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1].content).toBe("What is DataForge?");
    expect(messages[2].content).toBe("Answer 1.");
    expect(messages[3].content).toMatch(/Question: How often does it run\?$/);
    expect(embedInputs[1]).toBe("What is DataForge?\nHow often does it run?");
  });

  it("keeps only the last turns per conversation and caps stored content", async () => {
    const conversationId = "cap-test-0001";
    for (let i = 0; i < 7; i++) {
      await callWorker(ask({ question: `Q${i} ${"x".repeat(MAX_MEMORY_CHARS + 500)}`, conversationId }));
    }
    const stored = await rows(conversationId);
    expect(stored).toHaveLength(MAX_MESSAGES);
    expect(stored[0].content.startsWith("Q2 ")).toBe(true); // the two oldest turns were dropped
    expect(Math.max(...stored.map((r) => r.content.length))).toBe(MAX_MEMORY_CHARS);
    expect(llmInputs.at(-1).messages).toHaveLength(1 + MAX_MESSAGES + 1);
  });

  it("deletes messages older than the retention window", async () => {
    const old = Date.now() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    await env.DB.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES ('expired-conv-1', 'user', 'old', ?)").bind(old).run();

    await callWorker(ask({ question: "Anything new?" }));
    expect(await rows("expired-conv-1")).toEqual([]);
  });

  it("rejects a malformed conversationId", async () => {
    const res = await worker.fetch(ask({ question: "q", conversationId: "bad id; DROP TABLE" }), env, createExecutionContext());
    expect(res.status).toBe(400);
  });

  it("stays stateless when the DB binding is missing", async () => {
    const data = await callWorker(ask({ question: "q", conversationId: "ignored-without-db" }), { ...env, DB: undefined });
    expect(data.answer).toBe("Answer 1.");
    expect(data.conversationId).toBeUndefined();
    expect(llmInputs[0].messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("still answers when D1 fails", async () => {
    const broken = { prepare: () => { throw new Error("D1_ERROR: no such table: messages"); }, batch: async () => { throw new Error("D1 down"); } };
    const data = await callWorker(ask({ question: "q" }), { ...env, DB: broken });
    expect(data.answer).toBe("Answer 1.");
    expect(data.error).toBeUndefined();
  });
});

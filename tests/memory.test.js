import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { resolveConversationId, retrievalQuery } from "../src/memory.js";
import { reasoningAnswer, REASONING_MODEL } from "../src/reasoning.js";

describe("resolveConversationId", () => {
  test("generates an id when the client sends none", () => {
    for (const raw of [undefined, null, ""]) assert.match(resolveConversationId(raw).id, /^[0-9a-f-]{36}$/);
  });
  test("keeps a well-formed client id", () => {
    assert.deepEqual(resolveConversationId("abc_DEF-1234"), { id: "abc_DEF-1234" });
  });
  test("rejects ids that are too short, too long, not strings or with other characters", () => {
    for (const raw of ["short", "x".repeat(65), 12345678, "has spaces in it", "semi;colon-1234"]) {
      assert.ok(resolveConversationId(raw).error, String(raw));
    }
  });
});

describe("retrievalQuery", () => {
  test("is the question alone without history", () => assert.equal(retrievalQuery("q2", []), "q2"));
  test("prepends the previous question on a follow-up", () => {
    const history = [{ role: "user", content: "q0" }, { role: "assistant", content: "a0" }, { role: "user", content: "q1" }, { role: "assistant", content: "a1" }];
    assert.equal(retrievalQuery("q2", history), "q1\nq2");
  });
});

describe("reasoning mode with history", () => {
  test("writes earlier turns as a transcript in the single user message", async () => {
    let sent;
    const env = { AI: { run: async (_m, input) => { sent = input; return { response: "<think>ok</think>Daily." }; } } };
    await reasoningAnswer(env, [
      { role: "system", content: "Rules." },
      { role: "user", content: "What is DataForge?" },
      { role: "assistant", content: "An ETL." },
      { role: "user", content: "Context:\n[1] runs daily\n\nQuestion: How often?" },
    ]);
    assert.equal(sent.messages.length, 1);
    assert.match(sent.messages[0].content, /Conversation so far:\nUser: What is DataForge\?\nAssistant: An ETL\.\n\nContext:/);
  });
});

describe("POST /ask without the DB binding", () => {
  test("does not return a conversationId and ignores the one sent by the client", async () => {
    const calls = [];
    const env = {
      AI: { run: async (model, input) => {
        calls.push({ model, input });
        if (model.includes("bge-base")) return { data: [[0.1]] };
        if (model.includes("reranker")) return { response: [{ id: 0, score: 0.9 }] };
        if (model === REASONING_MODEL) return null;
        return { response: "Fast answer." };
      } },
      VECTORIZE: { query: async () => ({ matches: [{ score: 0.8, metadata: { text: "t", source: "s" } }] }) },
    };
    const req = new Request("https://rag.example/ask", { method: "POST", body: JSON.stringify({ question: "q", conversationId: "not valid!" }) });
    const res = await worker.fetch(req, env);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.conversationId, undefined);
    assert.equal(calls[0].input.text[0], "q");
  });
});

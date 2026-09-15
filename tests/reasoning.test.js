import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { splitReasoning, wantsReasoning, REASONING_MODEL, REASONING_MAX_TOKENS } from "../src/reasoning.js";

describe("splitReasoning", () => {
  test("separates the thinking from the answer", () => {
    assert.deepEqual(splitReasoning("<think>Step 1.\nStep 2.</think>\n\nIt runs daily."), {
      answer: "It runs daily.", reasoning: "Step 1.\nStep 2.", truncated: false,
    });
  });

  test("handles output where Workers AI dropped the opening tag", () => {
    const out = splitReasoning("The context says 6am.</think>Every day at 6am.");
    assert.equal(out.answer, "Every day at 6am.");
    assert.equal(out.reasoning, "The context says 6am.");
  });

  test("plain output without thinking is the answer", () => {
    assert.deepEqual(splitReasoning("Every day."), { answer: "Every day.", reasoning: "", truncated: false });
  });

  test("an unclosed <think> is a cut-off thought, not an answer", () => {
    const out = splitReasoning("<think>Let me check the context and");
    assert.equal(out.truncated, true);
    assert.equal(out.answer, "");
  });

  test("hitting the token limit without </think> counts as truncated", () => {
    assert.equal(splitReasoning("Let me check the context and", { hitLimit: true }).truncated, true);
  });
});

describe("wantsReasoning", () => {
  const url = (qs = "") => new URL(`https://rag.example/ask${qs}`);
  test("is off by default", () => assert.equal(wantsReasoning({ question: "q" }, url()), false));
  test("turns on with reasoning: true in the body", () => assert.equal(wantsReasoning({ reasoning: true }, url()), true));
  test("turns on with ?reasoning=true", () => assert.equal(wantsReasoning({}, url("?reasoning=true")), true));
  test("stays off for reasoning=false", () => assert.equal(wantsReasoning({ reasoning: "false" }, url("?reasoning=0")), false));
});

function askEnv({ reasoningOutput, reasoningError } = {}) {
  const calls = [];
  return {
    calls,
    AI: {
      run: async (model, input) => {
        calls.push({ model, input });
        if (model.includes("bge-base")) return { data: [[0.1, 0.2]] };
        if (model.includes("reranker")) return { response: [{ id: 0, score: 0.9 }] };
        if (model === REASONING_MODEL) {
          if (reasoningError) throw new Error(reasoningError);
          return reasoningOutput;
        }
        return { response: "Fast answer." };
      },
    },
    VECTORIZE: {
      query: async () => ({ matches: [{ score: 0.8, metadata: { text: "DataForge runs every day at 6am.", source: "profile" } }] }),
    },
  };
}

const ask = (body, qs = "") =>
  new Request(`https://rag.example/ask${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(body),
  });

const models = (env) => env.calls.map((c) => c.model);

describe("POST /ask reasoning mode", () => {
  test("uses the fast model unless reasoning is requested", async () => {
    const env = askEnv();
    const data = await (await worker.fetch(ask({ question: "How often does DataForge run?" }), env)).json();
    assert.equal(data.mode, "fast");
    assert.equal(data.answer, "Fast answer.");
    assert.equal(data.reasoning, undefined);
    assert.ok(!models(env).includes(REASONING_MODEL));
  });

  test("answers with R1 and returns its reasoning when asked", async () => {
    const env = askEnv({ reasoningOutput: { response: "<think>Context [1] says 6am daily.</think>\n\nEvery day at 6am.", usage: { completion_tokens: 40 } } });
    const data = await (await worker.fetch(ask({ question: "How often does DataForge run?", reasoning: true }), env)).json();
    assert.equal(data.mode, "reasoning");
    assert.equal(data.answer, "Every day at 6am.");
    assert.equal(data.reasoning, "Context [1] says 6am daily.");
    assert.deepEqual(data.sources, ["profile"]);

    const call = env.calls.find((c) => c.model === REASONING_MODEL);
    assert.equal(call.input.max_tokens, REASONING_MAX_TOKENS);
    assert.deepEqual(call.input.messages.map((m) => m.role), ["user"]);
    assert.match(call.input.messages[0].content, /ONLY the context/);
    assert.match(call.input.messages[0].content, /DataForge runs every day at 6am\./);
  });

  test("accepts ?reasoning=true", async () => {
    const env = askEnv({ reasoningOutput: { response: "ok</think>Daily." } });
    const data = await (await worker.fetch(ask({ question: "q" }, "?reasoning=true"), env)).json();
    assert.equal(data.mode, "reasoning");
    assert.equal(data.answer, "Daily.");
  });

  test("falls back to the fast model when R1 fails", async () => {
    const env = askEnv({ reasoningError: "capacity exceeded" });
    const data = await (await worker.fetch(ask({ question: "q", reasoning: true }), env)).json();
    assert.equal(data.mode, "fast");
    assert.equal(data.fallback, true);
    assert.equal(data.answer, "Fast answer.");
  });

  test("falls back when the thinking runs out of tokens", async () => {
    const env = askEnv({ reasoningOutput: { response: "<think>Let me look at every chunk", usage: { completion_tokens: REASONING_MAX_TOKENS } } });
    const data = await (await worker.fetch(ask({ question: "q", reasoning: true }), env)).json();
    assert.equal(data.mode, "fast");
    assert.equal(data.fallback, true);
  });
});

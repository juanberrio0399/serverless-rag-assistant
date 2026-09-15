import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker, { LLM_MODEL } from "../src/index.js";
import { REASONING_MODEL } from "../src/reasoning.js";

function env({ fastError, reasoningOutput, reasoningError } = {}) {
  const calls = [];
  return {
    calls,
    AI: {
      run: async (model, input) => {
        calls.push(model);
        if (model.includes("bge-base")) return { data: [[0.1, 0.2]] };
        if (model.includes("reranker")) return { response: [{ id: 0, score: 0.9 }] };
        if (model === REASONING_MODEL) {
          if (reasoningError) throw new Error(reasoningError);
          return reasoningOutput;
        }
        if (model === LLM_MODEL) {
          if (fastError) throw new Error(fastError);
          return { response: "Fast answer." };
        }
        throw new Error(`5028: ${model} was deprecated`);
      },
    },
    VECTORIZE: {
      query: async () => ({ matches: [{ score: 0.8, metadata: { text: "DataForge runs every day at 6am.", source: "profile" } }] }),
    },
  };
}

const ask = (body) =>
  new Request("https://rag.example/ask", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(body),
  });

describe("POST /ask fast model", () => {
  test("uses a current Workers AI model, not the deprecated llama-3.1-8b", async () => {
    assert.doesNotMatch(LLM_MODEL, /llama-3\.1-8b/);
    const e = env();
    const data = await (await worker.fetch(ask({ question: "How often does DataForge run?" }), e)).json();
    assert.equal(data.answer, "Fast answer.");
    assert.equal(data.mode, "fast");
    assert.ok(e.calls.includes(LLM_MODEL));
  });

  test("answers with the reasoning model when the fast model fails", async () => {
    const e = env({ fastError: "5028: model deprecated", reasoningOutput: { response: "<think>ok</think>Every day at 6am." } });
    const data = await (await worker.fetch(ask({ question: "How often does DataForge run?" }), e)).json();
    assert.equal(data.answer, "Every day at 6am.");
    assert.equal(data.mode, "reasoning");
    assert.equal(data.fallback, true);
    assert.equal(data.error, undefined);
  });

  test("returns an explicit error instead of a blank answer when every model fails", async () => {
    const e = env({ fastError: "down", reasoningError: "down" });
    const data = await (await worker.fetch(ask({ question: "q" }), e)).json();
    assert.equal(data.answer, "");
    assert.match(data.error, /No model returned an answer/);
  });
});

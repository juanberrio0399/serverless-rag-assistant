import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { MAX_READER_CHARS, CHUNK_SIZE, EMBED_BATCH } from "../src/ingest.js";
import {
  parseJobRequest, capBytes, planBatches, embedAndStoreBatch, readDocument, jobView,
  MAX_JOB_CHUNKS, MAX_JOB_TEXT_BYTES,
} from "../src/ingest-jobs.js";

const TOKEN = "test-token-123";

describe("parseJobRequest", () => {
  test("accepts inline text with a default source", () => {
    assert.deepEqual(parseJobRequest({ text: "hello" }), { params: { text: "hello", source: "manual" } });
  });
  test("accepts a public URL and uses it as the default source", () => {
    assert.deepEqual(parseJobRequest({ url: "https://example.com/a?b=1" }), {
      params: { url: "https://example.com/a?b=1", source: "https://example.com/a?b=1" },
    });
  });
  test("rejects both, neither and private URLs with 400", () => {
    for (const body of [{ text: "t", url: "https://example.com" }, {}, { text: "   " }, { url: "http://10.0.0.1/" }]) {
      assert.equal(parseJobRequest(body).status, 400, JSON.stringify(body));
    }
  });
  test("caps text at the reader limit and rejects payloads over the Workflow budget with 413", () => {
    assert.equal(parseJobRequest({ text: "a".repeat(MAX_READER_CHARS + 10) }).params.text.length, MAX_READER_CHARS);
    assert.equal(parseJobRequest({ text: "é".repeat(470 * 1024) }).status, 413); // 470k chars, ~940 KiB
  });
});

test("capBytes never splits a multi-byte character", () => {
  const out = capBytes("aé".repeat(10), 4); // a(1) é(2) a(1) = 4 bytes
  assert.equal(out, "aéa");
  assert.equal(capBytes("short", MAX_JOB_TEXT_BYTES), "short");
});

describe("planBatches", () => {
  test("indexes up to the job cap in embedding-sized batches", () => {
    const plan = planBatches("x".repeat(CHUNK_SIZE * (MAX_JOB_CHUNKS + 100)));
    assert.equal(plan.totalChunks, MAX_JOB_CHUNKS + 100);
    assert.equal(plan.chunks, MAX_JOB_CHUNKS);
    assert.equal(plan.truncated, true);
    assert.equal(plan.batches.length, Math.ceil(MAX_JOB_CHUNKS / EMBED_BATCH));
    assert.equal(plan.batches.at(-1).offset, MAX_JOB_CHUNKS - EMBED_BATCH);
    assert.equal(plan.batches.at(-1).chunks.length, EMBED_BATCH);
  });
});

describe("embedAndStoreBatch", () => {
  test("upserts vectors with ids derived from the job and chunk position", async () => {
    const upserts = [];
    const env = {
      AI: { run: async (_m, input) => ({ data: input.text.map(() => [0.5]) }) },
      VECTORIZE: { upsert: async (records) => { upserts.push(records); } },
    };
    assert.equal(await embedAndStoreBatch(env, "job-1", "doc", 50, ["a", "b"]), 2);
    assert.deepEqual(upserts[0].map((r) => r.id), ["job-1-50", "job-1-51"]);
    assert.deepEqual(upserts[0][1].metadata, { text: "b", source: "doc" });
  });
  test("fails the step when the embedding response does not match the batch", async () => {
    const env = { AI: { run: async () => ({ data: [[0.5]] }) }, VECTORIZE: { upsert: async () => assert.fail("must not store") } };
    await assert.rejects(embedAndStoreBatch(env, "job-1", "doc", 0, ["a", "b"]), /unexpected response/);
  });
});

describe("readDocument", () => {
  const reader = (status, body) => async () => new Response(body, { status });
  test("returns inline text without fetching", async () => {
    assert.equal(await readDocument({ text: "inline" }, () => assert.fail("no fetch")), "inline");
  });
  test("marks unreadable pages as permanent and transient errors as retryable", async () => {
    await assert.rejects(readDocument({ url: "https://example.com" }, reader(422, "cannot fetch")), (e) => e.permanent === true);
    await assert.rejects(readDocument({ url: "https://example.com" }, reader(503, "busy")), (e) => e.permanent === false);
    await assert.rejects(readDocument({ url: "https://example.com" }, reader(200, "Title: Empty\n\nMarkdown Content:\n")), (e) => e.permanent === true);
  });
  test("returns the page as Markdown", async () => {
    assert.equal(await readDocument({ url: "https://example.com" }, reader(200, "Title: T\n\nMarkdown Content:\nBody")), "# T\n\nBody");
  });
});

test("jobView exposes status, result and error message only", () => {
  assert.deepEqual(jobView("id1", { status: "complete", output: { chunks: 3 } }), { id: "id1", status: "complete", result: { chunks: 3 } });
  assert.deepEqual(jobView("id1", { status: "errored", error: { name: "Error", message: "boom" } }), { id: "id1", status: "errored", error: "boom" });
});

describe("/ingest-jobs endpoints", () => {
  function fakeEnv({ workflow = true } = {}) {
    const created = [];
    return {
      created,
      INGEST_TOKEN: TOKEN,
      ...(workflow ? {
        INGEST_WORKFLOW: {
          create: async ({ params }) => { created.push(params); return { id: "job-abc", status: async () => ({ status: "queued" }) }; },
          get: async (id) => {
            if (id !== "job-abc") throw new Error("instance.not_found");
            return { status: async () => ({ status: "complete", output: { chunks: 2 } }) };
          },
        },
      } : {}),
    };
  }
  const request = (method, path, body, token = TOKEN) => new Request(`https://rag.example${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  test("POST starts a job and answers 202 with its id and status URL", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(request("POST", "/ingest-jobs", { text: "hello", source: "doc" }), env);
    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.id, "job-abc");
    assert.equal(data.status, "queued");
    assert.equal(data.statusUrl, "/ingest-jobs/job-abc");
    assert.deepEqual(env.created, [{ text: "hello", source: "doc" }]);
  });

  test("requires the ingestion token and the Workflow binding", async () => {
    assert.equal((await worker.fetch(request("POST", "/ingest-jobs", { text: "t" }, "wrong"), fakeEnv())).status, 401);
    assert.equal((await worker.fetch(request("GET", "/ingest-jobs/job-abc", null, null), fakeEnv())).status, 401);
    assert.equal((await worker.fetch(request("POST", "/ingest-jobs", { text: "t" }), fakeEnv({ workflow: false }))).status, 503);
  });

  test("GET returns the job status, 400 for a malformed id and 404 for an unknown one", async () => {
    const ok = await worker.fetch(request("GET", "/ingest-jobs/job-abc"), fakeEnv());
    assert.deepEqual(await ok.json(), { id: "job-abc", status: "complete", result: { chunks: 2 } });
    assert.equal((await worker.fetch(request("GET", "/ingest-jobs/bad%20id"), fakeEnv())).status, 400);
    assert.equal((await worker.fetch(request("GET", "/ingest-jobs/job-missing"), fakeEnv())).status, 404);
  });
});

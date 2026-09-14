import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { chunkText, ingestText, parseTargetUrl, fetchReadable, MAX_CHUNKS, EMBED_BATCH, CHUNK_SIZE, READER_URL } from "../src/ingest.js";

const TOKEN = "test-token-123";

function fakeEnv({ token = TOKEN, limited = false } = {}) {
  const calls = { embed: [], insert: [], limit: [] };
  return {
    calls,
    INGEST_TOKEN: token,
    RATE_LIMITER: { limit: async (opts) => { calls.limit.push(opts.key); return { success: !limited }; } },
    AI: { run: async (model, input) => { calls.embed.push(input.text.length); return { data: input.text.map(() => [0.1, 0.2]) }; } },
    VECTORIZE: { insert: async (records) => { calls.insert.push(records); return { count: records.length }; } },
  };
}

const post = (path, body, { token = TOKEN } = {}) =>
  new Request(`https://rag.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

// Replaces global fetch for the Jina Reader call and records what the Worker sent.
function stubReader(response) {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return typeof response === "function" ? response(url, init) : response;
  };
  return { sent, restore: () => { globalThis.fetch = original; } };
}

const READER_PAGE = "Title: Example Domain\n\nURL Source: https://example.com/?a=1&b=2\n\nWarning: This page maybe not yet fully loaded.\n\nMarkdown Content:\nThis domain is for use in documentation examples.\n\n[Learn more](https://iana.org/domains/example)";

describe("parseTargetUrl", () => {
  test("accepts public http(s) URLs and keeps their query string", () => {
    assert.deepEqual(parseTargetUrl(" https://example.com/docs?a=1&b=2 "), { url: "https://example.com/docs?a=1&b=2" });
    assert.ok(parseTargetUrl("http://blog.example.org/post").url);
  });
  test("rejects other schemes, credentials, local and private targets", () => {
    for (const bad of ["", "not a url", "ftp://example.com/file", "javascript:alert(1)", "file:///etc/passwd",
      "https://user:pass@example.com", "http://localhost:8787", "http://api.localhost", "http://printer.local",
      "http://127.0.0.1", "http://10.0.0.5", "http://192.168.1.1", "http://172.20.0.1", "http://169.254.169.254/latest",
      "http://[::1]/", "http://[fd00::1]/", `https://example.com/${"a".repeat(2100)}`]) {
      assert.ok(parseTargetUrl(bad).error, `should reject ${bad.slice(0, 40)}`);
    }
    assert.ok(parseTargetUrl(undefined).error);
  });
});

describe("ingestText", () => {
  test("caps chunks and embeds and inserts in batches", async () => {
    const env = fakeEnv();
    const text = "x".repeat(CHUNK_SIZE * 250);
    const result = await ingestText(env, text, "big-doc");
    assert.deepEqual(result, { chunks: MAX_CHUNKS, totalChunks: 250, truncated: true });
    assert.deepEqual(env.calls.embed, Array(Math.ceil(MAX_CHUNKS / EMBED_BATCH)).fill(EMBED_BATCH));
    assert.equal(env.calls.insert.flat().length, MAX_CHUNKS);
    assert.ok(env.calls.insert.every((batch) => batch.length <= 100));
    assert.equal(env.calls.insert[0][0].metadata.source, "big-doc");
  });
  test("does not insert anything when an embedding call fails", async () => {
    const env = fakeEnv();
    env.AI.run = async () => ({ data: [] });
    await assert.rejects(ingestText(env, "hello world", "doc"));
    assert.equal(env.calls.insert.length, 0);
  });
  test("chunkText normalizes whitespace", () => {
    assert.deepEqual(chunkText("  a \n\n b  ", 2), ["a ", "b"]);
  });
});

describe("fetchReadable", () => {
  test("sends the URL in the body and keeps only the title and Markdown content", async () => {
    let seen;
    const out = await fetchReadable("https://example.com/?a=1&b=2", async (url, init) => { seen = { url, init }; return new Response(READER_PAGE); });
    assert.equal(seen.url, READER_URL);
    assert.equal(JSON.parse(seen.init.body).url, "https://example.com/?a=1&b=2");
    assert.ok(out.text.startsWith("# Example Domain\n\nThis domain is for use"));
    assert.ok(!out.text.includes("Warning:"));
  });
  test("maps reader failures to clear statuses", async () => {
    assert.equal((await fetchReadable("https://x.invalid", async () => new Response("SubmittedDataMalformedError: Domain could not be resolved", { status: 422 }))).status, 422);
    assert.equal((await fetchReadable("https://x.com", async () => new Response("slow down", { status: 429 }))).status, 429);
    assert.equal((await fetchReadable("https://x.com", async () => new Response("boom", { status: 500 }))).status, 502);
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    assert.equal((await fetchReadable("https://x.com", async () => { throw timeout; })).status, 504);
  });
});

describe("POST /ingest-url", () => {
  test("is disabled until the INGEST_TOKEN secret exists", async () => {
    const res = await worker.fetch(post("/ingest-url", { url: "https://example.com" }), fakeEnv({ token: "" }));
    assert.equal(res.status, 503);
  });
  test("rejects missing or wrong tokens", async () => {
    const env = fakeEnv();
    assert.equal((await worker.fetch(post("/ingest-url", { url: "https://example.com" }, { token: "" }), env)).status, 401);
    const wrong = await worker.fetch(post("/ingest-url", { url: "https://example.com" }, { token: "nope" }), env);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("www-authenticate"), "Bearer");
    assert.equal(env.calls.insert.length, 0);
  });
  test("is rate limited per IP with its own scope", async () => {
    const env = fakeEnv({ limited: true });
    const res = await worker.fetch(post("/ingest-url", { url: "https://example.com" }), env);
    assert.equal(res.status, 429);
    assert.deepEqual(env.calls.limit, ["ingest:203.0.113.7"]);
  });
  test("rejects invalid URLs before calling the reader", async () => {
    const reader = stubReader(new Response(READER_PAGE));
    try {
      const res = await worker.fetch(post("/ingest-url", { url: "http://169.254.169.254/latest/meta-data" }), fakeEnv());
      assert.equal(res.status, 400);
      assert.equal(reader.sent.length, 0);
    } finally { reader.restore(); }
  });
  test("reads the page and indexes it with the URL as source", async () => {
    const reader = stubReader(new Response(READER_PAGE));
    const env = fakeEnv();
    try {
      const res = await worker.fetch(post("/ingest-url", { url: "https://example.com/?a=1&b=2" }), env);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.source, "https://example.com/?a=1&b=2");
      assert.equal(body.chunks, 1);
      assert.equal(body.truncated, false);
      const record = env.calls.insert[0][0];
      assert.equal(record.metadata.source, "https://example.com/?a=1&b=2");
      assert.ok(record.metadata.text.startsWith("# Example Domain"));
    } finally { reader.restore(); }
  });
  test("returns 422 when the page cannot be read or has no text", async () => {
    const env = fakeEnv();
    let reader = stubReader(new Response("SubmittedDataMalformedError: Domain could not be resolved", { status: 422 }));
    try { assert.equal((await worker.fetch(post("/ingest-url", { url: "https://nope.invalid" }), env)).status, 422); } finally { reader.restore(); }
    reader = stubReader(new Response("Title: Empty\n\nMarkdown Content:\n   "));
    try {
      const res = await worker.fetch(post("/ingest-url", { url: "https://example.com/empty" }), env);
      assert.equal(res.status, 422);
    } finally { reader.restore(); }
    assert.equal(env.calls.insert.length, 0);
  });
});

describe("POST /ingest and the rest of the Worker", () => {
  test("/ingest now requires the token and still indexes text", async () => {
    const env = fakeEnv();
    assert.equal((await worker.fetch(post("/ingest", { text: "hello" }, { token: "" }), env)).status, 401);
    const res = await worker.fetch(post("/ingest", { text: "hello world", source: "notes" }), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json().then((b) => [b.ok, b.source, b.chunks]), [true, "notes", 1]);
  });
  test("/ingest rejects empty text", async () => {
    assert.equal((await worker.fetch(post("/ingest", { text: "   " }), fakeEnv())).status, 400);
  });
  test("GET / still serves the demo page without authentication", async () => {
    const res = await worker.fetch(new Request("https://rag.example/"), fakeEnv());
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Serverless RAG Assistant/);
  });
});

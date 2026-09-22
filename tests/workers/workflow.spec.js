// The ingestion Workflow running for real in Miniflare, started through the HTTP endpoint.
// Workers AI and Vectorize are mocked; step failures are injected with the Workflow introspector.
import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK_SIZE } from "../../src/ingest.js";

const TOKEN = "test-ingest-token";
let ipCounter = 0;
const request = (method, path, body) =>
  new Request(`https://rag.example${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "cf-connecting-ip": `203.0.113.${++ipCounter}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

let embedCalls;
let upserts;
beforeEach(() => {
  embedCalls = 0;
  upserts = [];
  vi.spyOn(env.AI, "run").mockImplementation(async (_model, input) => {
    embedCalls++;
    return { data: input.text.map(() => [0.1, 0.2]) };
  });
  vi.spyOn(env.VECTORIZE, "upsert").mockImplementation(async (records) => {
    upserts.push(records.map((r) => r.id));
    return { mutationId: "m" };
  });
});
afterEach(() => vi.restoreAllMocks());

const LONG_TEXT = "x".repeat(CHUNK_SIZE * 120); // 120 chunks → 3 batches, above the synchronous 100-chunk cap

describe("IngestWorkflow", () => {
  it("indexes a document beyond the synchronous cap and reports the result", async () => {
    await using introspector = await introspectWorkflow(env.INGEST_WORKFLOW);

    const res = await exports.default.fetch(request("POST", "/ingest-jobs", { text: LONG_TEXT, source: "big-doc" }));
    expect(res.status).toBe(202);
    const { id, statusUrl } = await res.json();

    const [instance] = await introspector.get();
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ source: "big-doc", chunks: 120, totalChunks: 120, truncated: false });
    expect(upserts.map((ids) => ids.length)).toEqual([50, 50, 20]);
    expect(upserts[2].at(-1)).toBe(`${id}-119`);

    const status = await (await exports.default.fetch(request("GET", statusUrl))).json();
    expect(status).toMatchObject({ id, status: "complete", result: { chunks: 120, source: "big-doc" } });
  });

  it("retries only the failed batch", async () => {
    await using introspector = await introspectWorkflow(env.INGEST_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "embed and store batch 2 of 3" }, new Error("3040: Capacity temporarily exceeded"), 2);
    });

    await exports.default.fetch(request("POST", "/ingest-jobs", { text: LONG_TEXT }));
    const [instance] = await introspector.get();
    await instance.waitForStatus("complete");

    expect(embedCalls).toBe(3); // batch 1 was not embedded again
    expect((await instance.getOutput()).chunks).toBe(120);
  });

  it("does not retry a page the reader cannot fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Domain not found", { status: 422 }));
    await using introspector = await introspectWorkflow(env.INGEST_WORKFLOW);

    const { statusUrl } = await (await exports.default.fetch(request("POST", "/ingest-jobs", { url: "https://unreadable.example/" }))).json();
    const [instance] = await introspector.get();
    await instance.waitForStatus("errored");

    // Two calls, not one: the reader, then the direct fetch that also fails. Neither is retried.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(upserts).toEqual([]);
    const status = await (await exports.default.fetch(request("GET", statusUrl))).json();
    expect(status.status).toBe("errored");
    // Miniflare reports a generic NonRetryableError message, so only its presence is asserted here.
    expect(status.error).toEqual(expect.any(String));
  });

  it("answers 404 for an unknown job and 400 for a malformed id", async () => {
    expect((await exports.default.fetch(request("GET", "/ingest-jobs/does-not-exist"))).status).toBe(404);
    expect((await exports.default.fetch(request("GET", "/ingest-jobs/-bad"))).status).toBe(400);
  });
});

// Durable ingestion of large documents (POST /ingest-jobs) with Cloudflare Workflows.
// The synchronous /ingest and /ingest-url keep their 100-chunk cap; a job indexes up to the full
// Jina Reader limit (~500k characters) in batches, and each batch is a step that is retried on its own.
// Plain functions so they can be unit-tested with `node --test`; src/workflow.js wires them into steps.

import { EMBED_MODEL, EMBED_BATCH, AVG_CHUNK_CHARS, MAX_READER_CHARS, chunkText, cleanSource, parseTargetUrl, readPage } from "./ingest.js";

// Chunks end on structural boundaries, so they are shorter than the target size: the cap is
// derived from the measured average (AVG_CHUNK_CHARS), not from the target, or a long document
// would be truncated before the reader's limit. 1000 chunks: 1 read + 20 embed + 20 upsert subrequests.
export const MAX_JOB_CHUNKS = Math.ceil(MAX_READER_CHARS / AVG_CHUNK_CHARS);
export const MAX_JOB_TEXT_BYTES = 900 * 1024;  // Workflow params and step results are limited to 1 MiB
export const JOB_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/;
export const STEP_CONFIG = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

const byteLength = (text) => new TextEncoder().encode(text).length;

// Truncates to a UTF-8 byte budget without splitting a character.
export function capBytes(text, max = MAX_JOB_TEXT_BYTES) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  return new TextDecoder().decode(bytes.slice(0, max)).replace(/�$/, "");
}

// Validates the request body. Returns { params } for the Workflow, or { status, error }.
export function parseJobRequest(body) {
  const hasText = typeof body?.text === "string" && body.text.trim() !== "";
  const hasUrl = body?.url !== undefined && body?.url !== null && body?.url !== "";
  if (hasText && hasUrl) return { status: 400, error: "Send either 'text' or 'url', not both." };
  if (hasUrl) {
    const target = parseTargetUrl(body.url);
    if (target.error) return { status: 400, error: target.error };
    return { params: { url: target.url, source: cleanSource(body.source, target.url) } };
  }
  if (!hasText) return { status: 400, error: "Missing 'text' or 'url' in body." };
  const text = body.text.slice(0, MAX_READER_CHARS);
  if (byteLength(text) > MAX_JOB_TEXT_BYTES) {
    return { status: 413, error: `Text is larger than ${MAX_JOB_TEXT_BYTES / 1024} KiB. Split it or ingest it by URL.` };
  }
  return { params: { text, source: cleanSource(body.source) } };
}

// Step 1 for URL jobs. Errors marked `permanent` must not be retried (the page cannot be read).
export async function readDocument(params, fetchImpl = fetch, { apiKey } = {}) {
  if (!params.url) return params.text;
  const page = await readPage(params.url, { fetchImpl, apiKey });
  if (page.error) throw Object.assign(new Error(page.error), { permanent: page.status === 422 });
  if (!page.text.replace(/^# .*$/m, "").trim()) {
    throw Object.assign(new Error("The page has no readable text."), { permanent: true });
  }
  return capBytes(page.text);
}

export function planBatches(text) {
  const all = chunkText(text);
  const chunks = all.slice(0, MAX_JOB_CHUNKS);
  const batches = [];
  for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH) {
    batches.push({ offset, chunks: chunks.slice(offset, offset + EMBED_BATCH) });
  }
  return { batches, chunks: chunks.length, totalChunks: all.length, truncated: all.length > chunks.length };
}

// One step per batch: embed, then upsert with ids derived from the job and chunk position, so a
// retried step overwrites its own vectors instead of duplicating them.
export async function embedAndStoreBatch(env, jobId, source, offset, chunks) {
  const { data } = await env.AI.run(EMBED_MODEL, { text: chunks });
  if (!Array.isArray(data) || data.length !== chunks.length) {
    throw new Error("Embedding model returned an unexpected response.");
  }
  const records = chunks.map((chunk, i) => ({
    id: `${jobId}-${offset + i}`,
    values: data[i],
    metadata: { text: chunk, source },
  }));
  await env.VECTORIZE.upsert(records);
  return records.length;
}

// Public view of a Workflow instance status.
export function jobView(id, { status, output, error } = {}) {
  return {
    id,
    status,
    ...(output ? { result: output } : {}),
    ...(error ? { error: error.message || String(error) } : {}),
  };
}

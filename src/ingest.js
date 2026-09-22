// Ingestion helpers shared by POST /ingest and POST /ingest-url.
// Kept separate from the Worker entry so they can be unit-tested with `node --test`.

import { chunkText, CHUNK_SIZE, AVG_CHUNK_CHARS } from "./chunker.js";

// Structure-aware chunking lives in src/chunker.js; re-exported here so callers keep one import.
export { chunkText, CHUNK_SIZE, AVG_CHUNK_CHARS };

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768-dim embeddings
export const MAX_CHUNKS = 100;          // cap per request (~50k chars at the measured average) to bound AI and Vectorize usage
export const EMBED_BATCH = 50;          // texts per Workers AI embedding call
export const INSERT_BATCH = 100;        // vectors per Vectorize insert (binding limit is 1000)
export const MAX_READER_CHARS = 500_000; // cap on the text accepted from Jina Reader
export const MAX_URL_LENGTH = 2048;
export const READER_URL = "https://r.jina.ai/";
export const READER_TIMEOUT_MS = 25_000;
export const DIRECT_TIMEOUT_MS = 20_000;  // fallback fetch: the page itself, when the reader is unavailable
export const MAX_DIRECT_BYTES = 3_000_000; // cap on the HTML downloaded by the fallback
export const DIRECT_USER_AGENT = "Mozilla/5.0 (compatible; serverless-rag-assistant/1.0; +https://github.com/juanberrio0399/serverless-rag-assistant)";

// Chunk → embed in batches → insert in batches. All embeddings are computed before the
// first insert, so an embedding failure never leaves a half-written document in the index.
export async function ingestText(env, text, source) {
  const all = chunkText(text);
  const chunks = all.slice(0, MAX_CHUNKS);
  const vectors = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const { data } = await env.AI.run(EMBED_MODEL, { text: batch });
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error("Embedding model returned an unexpected response.");
    }
    vectors.push(...data);
  }
  const records = chunks.map((chunk, i) => ({
    id: crypto.randomUUID(),
    values: vectors[i],
    metadata: { text: chunk, source },
  }));
  for (let i = 0; i < records.length; i += INSERT_BATCH) {
    await env.VECTORIZE.insert(records.slice(i, i + INSERT_BATCH));
  }
  return { chunks: chunks.length, totalChunks: all.length, truncated: all.length > chunks.length };
}

export function cleanSource(source, fallback = "manual") {
  const s = typeof source === "string" ? source.trim() : "";
  return (s || fallback).slice(0, 300);
}

// Only public http(s) pages: no credentials in the URL and no local or private network targets.
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export function parseTargetUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { error: "Missing 'url' in body." };
  if (value.length > MAX_URL_LENGTH) return { error: `URL is longer than ${MAX_URL_LENGTH} characters.` };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: "Invalid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "Only http and https URLs are supported." };
  if (url.username || url.password) return { error: "URLs with credentials are not allowed." };
  const host = url.hostname.toLowerCase();
  const isV6 = host.startsWith("[");
  if (
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
    PRIVATE_V4.some((re) => re.test(host)) ||
    (isV6 && (host === "[::1]" || host === "[::]" || /^\[(fc|fd|fe8|fe9|fea|feb)/.test(host)))
  ) {
    return { error: "Local and private network addresses are not allowed." };
  }
  return { url: url.toString() };
}

// Fetch a page as Markdown through Jina Reader. The URL goes in the JSON body so its own
// query string is preserved; the reader's header block (Title, Warning…) is reduced to a title.
export async function fetchReadable(url, fetchImpl = fetch, { apiKey } = {}) {
  let res;
  try {
    res = await fetchImpl(READER_URL, {
      method: "POST",
      // A free Jina key (JINA_API_KEY secret) raises the per-IP limit; without it the reader
      // often answers 429 because Cloudflare egress IPs are shared.
      headers: {
        accept: "text/plain",
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return { status: 504, error: timeout ? "The page took too long to read." : "Could not reach the page reader." };
  }
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    // The reader answers 422 when the page cannot be fetched (unresolvable domain, blocked site…).
    const status = res.status === 422 || res.status === 400 ? 422 : res.status === 429 ? 429 : 502;
    return { status, error: `The page could not be read (${res.status}): ${raw.replace(/\s+/g, " ").slice(0, 200)}` };
  }
  const marker = raw.indexOf("Markdown Content:");
  const body = marker >= 0 ? raw.slice(marker + "Markdown Content:".length) : raw;
  const title = (raw.slice(0, marker >= 0 ? marker : 0).match(/^Title:[ \t]*(.+)$/m) || [])[1];
  const text = `${title ? `# ${title.trim()}\n\n` : ""}${body.trim()}`.slice(0, MAX_READER_CHARS);
  return { text };
}

// Plain-text extraction for the fallback: drop the parts that never carry content, turn block
// boundaries into newlines, remove the remaining tags and decode the handful of entities that matter.
export function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const text = html
    .replace(/<(script|style|noscript|template|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title ? title.replace(/\s+/g, " ").trim() : "", text };
}

// Fallback when the reader fails: fetch the page directly and strip the HTML ourselves.
export async function fetchDirect(url, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "user-agent": DIRECT_USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return { status: timeout ? 504 : 502, error: timeout ? "The page took too long to load." : "Could not reach the page." };
  }
  if (!res.ok) return { status: res.status === 404 || res.status === 410 ? 422 : 502, error: `The page answered ${res.status}.` };
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("text/html") && !type.includes("text/plain") && !type.includes("xml")) {
    return { status: 415, error: `The page is not text (${type.split(";")[0] || "unknown type"}).` };
  }
  const raw = (await res.text().catch(() => "")).slice(0, MAX_DIRECT_BYTES);
  const parsed = type.includes("text/plain") ? { title: "", text: raw.trim() } : htmlToText(raw);
  return { text: `${parsed.title ? `# ${parsed.title}\n\n` : ""}${parsed.text}`.slice(0, MAX_READER_CHARS) };
}

// Read a page for ingestion: the reader first (best formatting), the page itself as a fallback.
// Returns { text, via } or { status, error }.
export async function readPage(url, { fetchImpl = fetch, apiKey } = {}) {
  const read = await fetchReadable(url, fetchImpl, { apiKey });
  if (!read.error) return { ...read, via: "reader" };

  const direct = await fetchDirect(url, fetchImpl);
  if (!direct.error) return { ...direct, via: "direct" };
  // Both failed: keep the reader's status and say what the direct attempt saw.
  return { status: read.status, error: `${read.error} Direct fetch also failed: ${direct.error}` };
}

// Ingestion is private: a Bearer token that matches the INGEST_TOKEN secret, compared in constant time.
// Returns "disabled" when the secret is not configured, so ingestion fails closed.
export async function checkIngestToken(request, env) {
  const expected = env.INGEST_TOKEN;
  if (!expected) return "disabled";
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return "unauthorized";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(token)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 ? "ok" : "unauthorized";
}

// Per-IP rate limit with a scope prefix so ingestion and questions do not share a budget.
// Optional binding: without RATE_LIMITER nothing is limited.
export async function isRateLimited(request, env, scope) {
  if (!env.RATE_LIMITER) return false;
  const ip = request.headers.get("cf-connecting-ip") || "anonymous";
  const { success } = await env.RATE_LIMITER.limit({ key: `${scope}:${ip}` });
  return !success;
}

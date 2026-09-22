<h1 align="center">🧠 Serverless RAG Assistant</h1>
<p align="center">Ask questions in plain language and get answers grounded in your own documents — running 100% serverless on Cloudflare, no server to maintain.</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers%20AI-F38020?style=flat-square&logo=cloudflare&logoColor=white"/>
  <img src="https://img.shields.io/badge/Vectorize-vector%20DB-F38020?style=flat-square"/>
  <img src="https://img.shields.io/badge/RAG-LLM%20integration-1d4ed8?style=flat-square"/>
  <img src="https://img.shields.io/badge/IaC-wrangler-2ea44f?style=flat-square"/>
</p>

<p align="center"><b>🌐 English</b> · <a href="README.es.md">Español</a></p>

---

## What it is

A **RAG** (Retrieval-Augmented Generation) service: it retrieves the most relevant pieces of your documents and lets an LLM answer **based on them** — instead of guessing. Built as a demonstration of **deploying and operating AI on cloud infrastructure**.

## Architecture (all serverless)

```
        ┌─────────── INGEST ───────────┐        ┌────────── ASK ──────────┐
Docs →  chunk → embeddings → Vectorize   |  question → embedding → Vectorize
        (Workers AI)   (vector DB)        |          (top-K search)
                                          |                 │
                                          |     candidate chunks → reranker
                                          |          (cross-encoder, precision)
                                          |                 ▼
                                          |     Workers AI (LLM) → answer
```

The **ASK** path is rate-limited per client IP (native Cloudflare rate limiting, no
extra storage) and over-retrieves candidates that a **cross-encoder reranker**
(`bge-reranker-base`) re-scores for true query↔chunk relevance before the LLM answers.

| Piece | Cloudflare service | Role |
|---|---|---|
| API / brain | **Worker** | receives the request and orchestrates |
| AI models | **Workers AI** | embeddings + the answering LLM |
| Vector database | **Vectorize** | stores & searches the vectors |
| Document storage | **R2** | holds the source files |
| Conversation memory | **D1** (optional) | last 5 turns per conversation, 7-day retention |
| Large-document ingestion | **Workflows** | durable, step-by-step embedding with retries |

## Tech / skills demonstrated

`Cloudflare Workers` · `Workers AI` · `Vectorize` · `R2` · `RAG` · `reranking (cross-encoder)` · `reasoning models (DeepSeek-R1)` · `rate limiting` · `LLM integration` · `embeddings` · `Infrastructure as Code (wrangler)` · `serverless` · `CI/CD`

## Live demo

🟢 **Live:** https://serverless-rag-assistant.tienvo.workers.dev

```bash
# 1) Teach it a document (ingestion is private: Bearer token = INGEST_TOKEN secret)
curl -X POST https://serverless-rag-assistant.tienvo.workers.dev/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"text":"Your document text here...","source":"my-doc"}'

# 1b) …or a web page: read as clean Markdown through Jina Reader, then chunked and embedded
curl -X POST https://serverless-rag-assistant.tienvo.workers.dev/ingest-url \
  -H "authorization: Bearer $INGEST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"url":"https://developers.cloudflare.com/vectorize/"}'

# 2) Ask (grounded in your docs — wait ~10s after ingesting)
curl -X POST https://serverless-rag-assistant.tienvo.workers.dev/ask \
  -H "content-type: application/json" \
  -d '{"question":"..."}'

# 2a) Follow-up in the same conversation: send back the conversationId from the previous answer
curl -X POST https://serverless-rag-assistant.tienvo.workers.dev/ask \
  -H "content-type: application/json" \
  -d '{"question":"And how often does it run?","conversationId":"<id from the previous answer>"}'

# 2b) Reasoning mode (opt-in): DeepSeek-R1 thinks before answering and returns its reasoning
curl -X POST "https://serverless-rag-assistant.tienvo.workers.dev/ask?reasoning=true" \
  -H "content-type: application/json" \
  -d '{"question":"..."}'
```

**Two answering modes** — the response says which one ran (`mode`):

| | `fast` (default) | `reasoning` (`"reasoning": true` or `?reasoning=true`) |
|---|---|---|
| Model | `llama-3.3-70b-instruct-fp8-fast` | `deepseek-r1-distill-qwen-32b` |
| Latency | ~1-3 s | ~10-30 s |
| Best for | direct lookups | questions that combine several facts |
| Extra output | — | `reasoning` (the model's step-by-step thinking) |

Reasoning is opt-in because it is slower and costlier: in testing, one reasoning answer took ~9 s and used ~110 of the 10,000 free Workers AI neurons per day. If R1 fails or runs out of tokens, `/ask` still answers with the fast model and adds `fallback: true`.

**How a URL is read:** first through Jina Reader (best formatting). If the reader fails — it rate limits per IP and Cloudflare's egress IPs are shared, so `429 Per IP rate limit exceeded` is common — the Worker fetches the page itself and strips the HTML. The response says which path was used (`read_with: "reader" | "direct"`). Setting the optional `JINA_API_KEY` secret (free tier) raises the reader's limit: `wrangler secret put JINA_API_KEY`.

Ingestion endpoints are rate limited per IP, accept only public http(s) pages, and index at most 100 chunks (~80k characters) per request (`truncated: true` when a page is longer). Enable them with `wrangler secret put INGEST_TOKEN`; without the secret they answer 503.

### Large documents (Cloudflare Workflows)

For pages or texts beyond the 100-chunk cap, `POST /ingest-jobs` starts a durable **Workflow** and answers `202` with a job id. The job reads the page (URL jobs), then embeds and stores it in batches of 50 chunks; each batch is a step retried with exponential backoff, so a Workers AI or Vectorize error does not restart the whole document. Vector ids are derived from the job and chunk position, so a retried batch overwrites its own vectors instead of duplicating them. A job indexes up to 625 chunks (~500k characters, the Jina Reader cap); text sent inline is limited to 900 KiB (Workflow payloads are capped at 1 MiB). Same token and rate limit as the other ingestion endpoints. Completed job status is kept for 3 days on the Workers Free plan.

```bash
curl -X POST https://serverless-rag-assistant.tienvo.workers.dev/ingest-jobs \
  -H "authorization: Bearer $INGEST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"url":"https://developers.cloudflare.com/workflows/"}'
# → 202 {"id":"…","status":"queued","statusUrl":"/ingest-jobs/…"}

curl https://serverless-rag-assistant.tienvo.workers.dev/ingest-jobs/<id> \
  -H "authorization: Bearer $INGEST_TOKEN"
# → {"id":"…","status":"complete","result":{"chunks":412,"totalChunks":412,"truncated":false,…}}
```

### Conversation memory (D1)

With the optional `DB` binding (Cloudflare D1), `/ask` remembers the **last 5 question/answer turns** of a conversation, so follow-ups such as "and how often does it run?" work. Every answer returns a `conversationId`; send it back in the next request (the demo page does this for the current page session). Without an id a new conversation starts; a malformed id returns 400. Without the binding, or if D1 is unavailable, `/ask` stays stateless and answers as before.

Privacy and retention, because the demo is public:
- Stored per message: conversation id, role, text (capped at 2,000 characters) and timestamp. **No IP address**, user agent or other request data.
- Messages older than **7 days** are deleted on each write, and each conversation keeps at most 10 messages.
- Anyone who has a `conversationId` can continue that conversation, so do not share ids and do not type personal data in the demo.

Setup (once): `npx wrangler d1 create rag-memory`, paste the returned `database_id` into `wrangler.jsonc`, then `npx wrangler d1 migrations apply rag-memory --remote`.

**Highlights:**
- **Anti-hallucination** — replies "I don't know" when the answer isn't in your documents (prompt-engineered guardrail).
- **Multilingual** — answers in the language you ask.
- **Source tracking** — every answer returns which document it came from, plus similarity scores.
- **~$0 infrastructure** — serverless, no server or database to host.

## Tests

Two suites run in CI on every push and pull request:

| Suite | Command | What it covers |
|---|---|---|
| Unit | `npm run test:unit` | `node:test` with fake bindings: chunking, URL validation, Jina Reader parsing, model fallbacks, reasoning mode |
| Runtime | `npm run test:workers` | Vitest inside **workerd** (`@cloudflare/vitest-plugin`) with the bindings from `wrangler.jsonc`: routing, `/ask` validation, ingestion auth (401/503), the local rate-limiter simulator (429), conversation memory on local D1 with the real migrations, the ingestion Workflow end to end (step retries, deterministic ids, status endpoint) |

`npm test` runs both. Workers AI and Vectorize have no local simulator, so the runtime suite sets `remoteBindings: false` and mocks them with `vi.spyOn`: tests never reach a Cloudflare account and need no credentials.

---

> Built by **Juan Berrio** — Cloud &amp; Data Engineer. Portfolio: [juanberrio0399.github.io](https://juanberrio0399.github.io)

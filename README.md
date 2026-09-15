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

# 2b) Reasoning mode (opt-in): DeepSeek-R1 thinks before answering and returns its reasoning
curl -X POST "https://serverless-rag-assistant.tienvo.workers.dev/ask?reasoning=true" \
  -H "content-type: application/json" \
  -d '{"question":"..."}'
```

**Two answering modes** — the response says which one ran (`mode`):

| | `fast` (default) | `reasoning` (`"reasoning": true` or `?reasoning=true`) |
|---|---|---|
| Model | `llama-3.1-8b-instruct` | `deepseek-r1-distill-qwen-32b` |
| Latency | ~1-3 s | ~10-30 s |
| Best for | direct lookups | questions that combine several facts |
| Extra output | — | `reasoning` (the model's step-by-step thinking) |

Reasoning is opt-in because it is slower and costlier: in testing, one reasoning answer took ~9 s and used ~110 of the 10,000 free Workers AI neurons per day. If R1 fails or runs out of tokens, `/ask` still answers with the fast model and adds `fallback: true`.

Ingestion endpoints are rate limited per IP, accept only public http(s) pages, and index at most 100 chunks (~80k characters) per request (`truncated: true` when a page is longer). Enable them with `wrangler secret put INGEST_TOKEN`; without the secret they answer 503.

**Highlights:**
- **Anti-hallucination** — replies "I don't know" when the answer isn't in your documents (prompt-engineered guardrail).
- **Multilingual** — answers in the language you ask.
- **Source tracking** — every answer returns which document it came from, plus similarity scores.
- **~$0 infrastructure** — serverless, no server or database to host.

---

> Built by **Juan Berrio** — Cloud &amp; Data Engineer. Portfolio: [juanberrio0399.github.io](https://juanberrio0399.github.io)

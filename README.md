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

`Cloudflare Workers` · `Workers AI` · `Vectorize` · `R2` · `RAG` · `reranking (cross-encoder)` · `rate limiting` · `LLM integration` · `embeddings` · `Infrastructure as Code (wrangler)` · `serverless` · `CI/CD`

## Live demo

🟢 **Live:** https://serverless-rag-assistant.tienvo.workers.dev

```bash
# 1) Teach it a document
curl -X POST https://serverless-rag-assistant.tienvo.workers.dev/ingest \
  -H "content-type: application/json" \
  -d '{"text":"Your document text here...","source":"my-doc"}'

# 2) Ask (grounded in your docs — wait ~10s after ingesting)
curl -X POST https://serverless-rag-assistant.tienvo.workers.dev/ask \
  -H "content-type: application/json" \
  -d '{"question":"..."}'
```

**Highlights:**
- **Anti-hallucination** — replies "I don't know" when the answer isn't in your documents (prompt-engineered guardrail).
- **Multilingual** — answers in the language you ask.
- **Source tracking** — every answer returns which document it came from, plus similarity scores.
- **~$0 infrastructure** — serverless, no server or database to host.

---

> Built by **Juan Berrio** — Cloud &amp; Data Engineer. Portfolio: [juanberrio0399.github.io](https://juanberrio0399.github.io)

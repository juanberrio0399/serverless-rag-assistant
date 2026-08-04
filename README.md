<h1 align="center">🧠 Serverless RAG Assistant</h1>
<p align="center">Ask questions in plain language and get answers grounded in your own documents — running 100% serverless on Cloudflare, no server to maintain.</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers%20AI-F38020?style=flat-square&logo=cloudflare&logoColor=white"/>
  <img src="https://img.shields.io/badge/Vectorize-vector%20DB-F38020?style=flat-square"/>
  <img src="https://img.shields.io/badge/RAG-LLM%20integration-1d4ed8?style=flat-square"/>
  <img src="https://img.shields.io/badge/IaC-wrangler-2ea44f?style=flat-square"/>
</p>

---

## What it is

A **RAG** (Retrieval-Augmented Generation) service: it retrieves the most relevant pieces of your documents and lets an LLM answer **based on them** — instead of guessing. Built as a demonstration of **deploying and operating AI on cloud infrastructure**.

## Architecture (all serverless)

```
        ┌─────────── INGEST ───────────┐        ┌────────── ASK ──────────┐
Docs →  chunk → embeddings → Vectorize   |  question → embedding → Vectorize
        (Workers AI)   (vector DB)        |          (top-K search)
                                          |                 │
                                          |     relevant chunks + question
                                          |                 ▼
                                          |     Workers AI (LLM) → answer
```

| Piece | Cloudflare service | Role |
|---|---|---|
| API / brain | **Worker** | receives the request and orchestrates |
| AI models | **Workers AI** | embeddings + the answering LLM |
| Vector database | **Vectorize** | stores & searches the vectors |
| Document storage | **R2** | holds the source files |

## Tech / skills demonstrated

`Cloudflare Workers` · `Workers AI` · `Vectorize` · `R2` · `RAG` · `LLM integration` · `embeddings` · `Infrastructure as Code (wrangler)` · `serverless` · `CI/CD`

## Status

🚧 In progress — built step by step. See commits for the build log.

---

> Built by **Juan Berrio** — Cloud &amp; Data Engineer. Portfolio: [juanberrio0399.github.io](https://juanberrio0399.github.io)

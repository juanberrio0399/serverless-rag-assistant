# Plan — Serverless RAG Assistant

Updated: 2026-10-11 · Status: **live** at <https://serverless-rag-assistant.tienvo.workers.dev>

How it works is in the [README](README.md). This file says where the project stands and what comes next.

## What it is

Question answering grounded in your own documents, running entirely on Cloudflare's edge: no server, no database host, no container. Feed it text or a URL; it answers with citations and says "I don't know" when the answer is not there. It is a portfolio piece for LLM integration, RAG and serverless infrastructure.

## How it works today

| Piece | Where |
|---|---|
| Ingestion (text, URL via Jina Reader with direct-fetch fallback), private with a Bearer token | `POST /ingest`, `/ingest-url` |
| Large documents as durable, retried batches | Cloudflare Workflows, `POST /ingest-jobs` |
| Structure-aware chunking (≤1000 chars, heading path kept) | `src/` |
| Prompt-injection defense on documents, context and answers | `src/guard.js` |
| Two-stage retrieval: Vectorize search + cross-encoder rerank | `POST /ask`, public and rate limited per IP |
| Optional conversation memory | D1 (`rag-memory`) |
| Optional reasoning mode | DeepSeek-R1 via Workers AI |
| Tests inside `workerd` | `@cloudflare/vitest-plugin`; CodeQL on every PR |

## What it needs

- Cloudflare free tier: Workers AI (10,000 neurons/day), one Vectorize index, one D1 database.
- `INGEST_TOKEN` in the Worker; `GROQ_API_KEY` as a repo secret.
- Cost: 0.

## How it should work

- Every ingested document is treated as hostile input.
- An answer either cites its source or says it does not know.
- A noisy corpus does not pull the wrong chunk into the prompt (rerank).
- The public `/ask` endpoint cannot burn the daily Workers AI quota.

## What was done

| Date | What | PR |
|---|---|---|
| 2026-08 | First version: ingest, Vectorize, `/ask` | — |
| 2026-09-14/15 | URL ingestion, reasoning mode, D1 memory, Workflows ingestion, tests in `workerd` | #54–#61 |
| 2026-09-21/22 | Jina fallback, structure-aware chunking, prompt-injection guard | #65–#67 |
| 2026-09-23 | CodeQL, Dependabot, both READMEs rewritten | #68–#72 |
| 2026-10-02 | Dependencies updated; vitest pinned to 4.x until Cloudflare's plugin supports 5 | #75, #77 |

## What's left

1. **#74: no AI Gateway.** `/ask` makes up to 3 Workers AI calls per question, with no cache and no observability. Highest value next step.
2. #30: semantic cache with Vectorize + KV (pairs with #74).
3. #48: RAG observability (Langfuse).
4. #49: interactive API docs (OpenAPI with Scalar).
5. #50: GitHub discoverability and social preview.
6. Dependabot #78 (npm group) is open.

## Known traps

- **vitest 5 is blocked**: `@cloudflare/vitest-plugin` (1.3.5, latest) requires `vitest@^4`. `dependabot.yml` ignores the major on purpose; remove that once Cloudflare ships support.
- **Jina Reader rate-limits**; the direct-fetch fallback strips HTML itself.
- **The deprecated answering model once returned blank answers**; the code now never returns an empty answer.

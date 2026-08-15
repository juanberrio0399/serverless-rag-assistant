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

> 💡 **Repository Discoverability**: Configured with GitHub topics (`rag`, `cloudflare-workers`, `workers-ai`, `vectorize`, `llm`, `serverless`, `r2`, `ai`), a live demo link in the About section, and a custom social preview image (`assets/social-preview.png`).

## Case Study Overview

- **Problem**: Building low-latency, secure RAG systems without managing servers or incurring high idle costs.
- **Solution**: A fully serverless RAG pipeline leveraging Cloudflare's edge ecosystem (Workers AI, Vectorize, R2).
- **Engineering Decisions**: Edge compute for minimal latency, vector database separation from unstructured storage, and strict prompt-engineered guardrails against hallucinations.
- **Results**: ~$0 ongoing idle infrastructure cost, 100% serverless footprint, and high determinism in answers.

## What it is

A **RAG** (Retrieval-Augmented Generation) service: it retrieves the most relevant pieces of your documents and lets an LLM answer **based on them** — instead of guessing. Built as a demonstration of **deploying and operating AI on cloud infrastructure**.

## Architecture (all serverless)


        ┌─────────── INGEST ───────────┐        ┌────────── ASK ──────────┐
Docs →  chunk → embeddings → Vectorize   |  question → embedding → Vectorize
        (Workers AI)   (vector DB)        |          (top-K search)
                                          |                 │
                                          |     relevant chunks + question
                                          |                 ▼
                                          |     Workers AI (LLM) → answer


| Piece | Cloudflare service | Role |
|---|---|---|
| API / brain | **Worker** | receives the request and orchestrates |
| AI models | **Workers AI** | embeddings + the answering LLM |
| Vector database | **Vectorize** | stores & searches the vectors |
| Document storage | **R2** | holds the source files |

## Tech / skills demonstrated

`Cloudflare Workers` · `Workers AI` · `Vectorize` · `R2` · `RAG` · `LLM integration` · `embeddings` · `Infrastructure as Code (Terraform, Wrangler)` · `serverless` · `CI/CD`

## Live demo

> **TODO:** Redeploy this Worker under Juan Berrio's personal Cloudflare account/domain and update this URL.

🟢 **Try it in your browser — no terminal needed:** https://<TU-SUBDOMINIO>.workers.dev

The Worker itself serves a small **web UI** (vanilla HTML/JS, no build step): pick an example question, hit **Get answer**, and see the grounded response **with its source document and similarity scores** in one click. An *Advanced* panel lets you ingest your own document (token-protected — you paste the token, nothing is stored in the page).

![Serverless RAG Assistant — browser demo: ask a question, get a grounded answer with sources and similarity scores](docs/demo.gif)

<!-- The GIF above is recorded separately (binary not committed by the code change). See docs/DEMO.md for the 20-second recording script. Until it is added the image link will be broken — that is expected on this branch. -->

> *GIF recording pending — see [`docs/DEMO.md`](docs/DEMO.md) for the exact ingest → ask → answer flow to capture.*

<details>
<summary><b>Prefer the terminal?</b> Same thing with <code>curl</code> (secondary reference)</summary>

bash
# 1) Teach it a document  (ingest is token-protected)
curl -X POST https://<TU-SUBDOMINIO>.workers.dev/ingest \
  -H "content-type: application/json" \
  -H "authorization: Bearer <YOUR_INGEST_TOKEN>" \
  -d '{"text":"Your document text here...","source":"my-doc"}'

# 2) Ask (grounded in your docs — wait ~10s after ingesting)
curl -X POST https://<TU-SUBDOMINIO>.workers.dev/ask \
  -H "content-type: application/json" \
  -d '{"question":"..."}'


</details>

**Highlights:**
- **Anti-hallucination** — replies "I don't know" when the answer isn't in your documents (prompt-engineered guardrail).
- **Multilingual** — answers in the language you ask.
- **Source tracking** — every answer returns which document it came from, plus similarity scores.
- **~$0 infrastructure** — serverless, no server or database to host.

---

> Built by **Juan Berrio** — Cloud &amp; Data Engineer. Explore my complete portfolio and CV at [juanberrio0399.github.io](https://juanberrio0399.github.io).

## License
This project is licensed under the Apache-2.0 License. Any reuse of this code must retain the copyright notice and attribution to Juan Berrio. See the [LICENSE](./LICENSE) file for details.

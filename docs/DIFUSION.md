# Plan de Difusión — Serverless RAG Assistant

Este documento contiene el plan, copys y estrategias de lanzamiento listas para usar en las distintas comunidades técnicas de alta afinidad.

---

## 1. Awesome Lists de Cloudflare

Las entradas en lists curadas generan tráfico de referencia permanente y mejoran la autoridad del repo.

### Repositorios objetivo:
- [`irazasyed/awesome-cloudflare`](https://github.com/irazasyed/awesome-cloudflare)
- [`ghostwriternr/awesome-cloudflare`](https://github.com/ghostwriternr/awesome-cloudflare)

### Sección recomendada:
- `Projects` / `Workers` / `AI` (dependiendo de la estructura exacta del list).

### Entrada propuesta (formato Markdown):
markdown
- [Serverless RAG Assistant](https://github.com/juanberrio0399/serverless-rag-assistant) - 100% serverless RAG built on Cloudflare Workers, Workers AI, Vectorize, and R2 with anti-hallucination guardrails (~$0 infra).


### Pasos para abrir el PR:
1. Leer el `CONTRIBUTING.md` de cada repositorio.
2. Asegurarse de mantener el orden alfabético si aplica.
3. Abrir el Pull Request con un título descriptivo como: `Add Serverless RAG Assistant to AI/Workers section`.

---

## 2. Show HN (Hacker News)

### Timing recomendado:
- Martes a Jueves, entre las 8:00 AM y 10:00 AM PT (para maximizar visibilidad en la página principal).

### Borrador:
- **Título:** Show HN: Serverless RAG on Cloudflare – grounded answers, ~$0 infra
- **URL:** https://github.com/juanberrio0399/serverless-rag-assistant

**Comentario inicial sugerido (para publicar justo después de enviar el post):**
> Hi HN!
> 
> I built a 100% serverless RAG (Retrieval-Augmented Generation) assistant running entirely on Cloudflare infrastructure: Workers AI for embeddings and LLM inference, Vectorize as the vector database, and R2 for document storage.
> 
> Motivation: I wanted to see how far you could push a complete AI workload without managing any traditional servers, databases, or paying high idle fees. It features strict anti-hallucination guardrails (saying 'I don't know' when context is missing), multilingual support, and source tracking.
> 
> Live demo link is in the repo, along with full IaC setup via Wrangler.
> 
> Curious to hear your thoughts or answer any questions about the Cloudflare developer stack!

---

## 3. Subreddits Técnicos

*Nota: Respetar las reglas de cada subreddit sobre autopromoción, enfocándose en compartir arquitectura y lecciones aprendidas más que en pedir estrellas.*

### r/LLMDevs / r/Rag
- **Título:** Built a serverless RAG pipeline on Cloudflare Workers AI + Vectorize (~$0 infra)
- **Cuerpo / Ángulo:**
  > Hey everyone, I wanted to share a project I built exploring production-ready RAG patterns without managing heavy backend servers. It runs entirely on Cloudflare's serverless ecosystem (Workers AI for BGE embeddings + Llama models, Vectorize for vector search, and R2 for raw docs).
  > 
  > Key implementation details:
  > - Handles chunking and vector distance matching natively.
  > - Added strict prompt-engineered guardrails against hallucination.
  > - Zero idle costs, fast global edge response times.
  > 
  > Code and architecture details are open source: https://github.com/juanberrio0399/serverless-rag-assistant. Happy to discuss the limitations of edge vector search or tradeoffs!

### r/CloudFlare
- **Título:** Pushing Workers AI & Vectorize to the limit: Built a complete serverless RAG assistant
- **Cuerpo / Ángulo:**
  > Hi Cloudflare community,
  > 
  > I put together a fully serverless RAG assistant leveraging Workers AI, Vectorize, R2, and Workers. It's a great example of how cohesive the Cloudflare developer platform has become for building AI apps with zero server management.
  > 
  > Check it out if you're looking for reference architecture on serverless AI: https://github.com/juanberrio0399/serverless-rag-assistant

---

## 4. Dev.to Article Outline

- **Título:** Building a $0 Serverless RAG on Cloudflare Workers (Workers AI + Vectorize)
- **Tags:** `#cloudflare` `#ai` `#rag` `#javascript`
- **Outline:**
  1. **Introduction:** The problem with traditional RAG hosting costs and server maintenance.
  2. **The Stack:** Why Cloudflare (Workers, Workers AI, Vectorize, R2).
  3. **Architecture Overview:** Ingest pipeline (chunking + embeddings) vs. Query pipeline (vector search + LLM generation).
  4. **Code Walkthrough:** Core worker logic connecting Vectorize and Workers AI bindings.
  5. **Guardrails & Lessons Learned:** Handling anti-hallucination prompts and edge constraints.
  6. **Conclusion & Repo Link.**

---

## 5. Checklist de Lanzamiento

- [ ] Verificar que el README y la demo en vivo estén funcionando correctamente.
- [ ] Enviar PRs a `irazasyed/awesome-cloudflare` y `ghostwriternr/awesome-cloudflare`.
- [ ] Publicar Show HN (Martes/Miércoles 9:00 AM PT).
- [ ] Compartir en r/LLMDevs y r/Rag con enfoque técnico.
- [ ] Escribir y publicar el artículo en Dev.to.

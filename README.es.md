<h1 align="center">🧠 Serverless RAG Assistant</h1>
<p align="center">Haz preguntas en lenguaje natural y obtén respuestas basadas en tus propios documentos — 100% serverless en Cloudflare, sin servidor que mantener.</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers%20AI-F38020?style=flat-square&logo=cloudflare&logoColor=white"/>
  <img src="https://img.shields.io/badge/Vectorize-vector%20DB-F38020?style=flat-square"/>
  <img src="https://img.shields.io/badge/RAG-LLM%20integration-1d4ed8?style=flat-square"/>
  <img src="https://img.shields.io/badge/IaC-wrangler-2ea44f?style=flat-square"/>
</p>

<p align="center"><a href="README.md">English</a> · <b>🌐 Español</b></p>

---

## Qué es

Un servicio **RAG** (Generación Aumentada por Recuperación): recupera los fragmentos más relevantes de tus documentos y deja que un LLM responda **con base en ellos**, en lugar de adivinar. Construido como demostración de **desplegar y operar IA sobre infraestructura cloud**.

## Arquitectura (todo serverless)

```
        ┌─────────── INGESTA ──────────┐        ┌────────── PREGUNTA ─────┐
Docs →  trozos → embeddings → Vectorize   |  pregunta → embedding → Vectorize
        (Workers AI)   (base vectorial)    |          (búsqueda top-K)
                                          |                 │
                                          |     fragmentos relevantes + pregunta
                                          |                 ▼
                                          |     Workers AI (LLM) → respuesta
```

| Pieza | Servicio Cloudflare | Rol |
|---|---|---|
| API / cerebro | **Worker** | recibe la petición y orquesta |
| Modelos de IA | **Workers AI** | embeddings + el LLM que responde |
| Base vectorial | **Vectorize** | guarda y busca los vectores |
| Almacenamiento | **R2** | guarda los documentos originales |

## Tecnologías / habilidades demostradas

`Cloudflare Workers` · `Workers AI` · `Vectorize` · `R2` · `RAG` · `Integración de LLM` · `embeddings` · `Infraestructura como código (wrangler)` · `serverless` · `CI/CD`

## Demo en vivo

🟢 **En vivo:** https://serverless-rag-assistant.tienvo.workers.dev

```bash
# 1) Enseñarle un documento (la ingesta es privada: token Bearer = secreto INGEST_TOKEN)
curl -X POST https://serverless-rag-assistant.tienvo.workers.dev/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"text":"El texto de tu documento aquí...","source":"mi-doc"}'

# 1b) …o una página web: se lee como Markdown limpio con Jina Reader y luego se fragmenta y vectoriza
curl -X POST https://serverless-rag-assistant.tienvo.workers.dev/ingest-url \
  -H "authorization: Bearer $INGEST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"url":"https://developers.cloudflare.com/vectorize/"}'

# 2) Preguntar (con base en tus documentos — espera ~10s tras ingerir)
curl -X POST https://serverless-rag-assistant.tienvo.workers.dev/ask \
  -H "content-type: application/json" \
  -d '{"question":"..."}'
```

Los endpoints de ingesta tienen rate limit por IP, solo aceptan páginas públicas http(s) e indexan como máximo 100 fragmentos (~80 mil caracteres) por petición (`truncated: true` si la página es más larga). Se activan con `wrangler secret put INGEST_TOKEN`; sin el secreto responden 503.

**Puntos clave:**
- **Anti-alucinación** — responde "no sé" cuando la respuesta no está en tus documentos (guardarraíl por prompt engineering).
- **Multilingüe** — responde en el idioma en que preguntes.
- **Trazabilidad de fuente** — cada respuesta indica de qué documento salió, con su puntaje de similitud.
- **~$0 de infraestructura** — serverless, sin servidor ni base de datos que alojar.

---

> Hecho por **Juan Berrio** — Cloud &amp; Data Engineer. Portafolio: [juanberrio0399.github.io](https://juanberrio0399.github.io)

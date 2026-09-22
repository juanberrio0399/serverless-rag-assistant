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
| Memoria de conversación | **D1** (opcional) | últimos 5 turnos por conversación, retención de 7 días |
| Ingesta de documentos grandes | **Workflows** | vectorización durable por pasos, con reintentos |

## Tecnologías / habilidades demostradas

`Cloudflare Workers` · `Workers AI` · `Vectorize` · `R2` · `RAG` · `Modelos de razonamiento (DeepSeek-R1)` · `Integración de LLM` · `embeddings` · `Infraestructura como código (wrangler)` · `serverless` · `CI/CD`

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

# 2a) Seguimiento en la misma conversación: reenvía el conversationId de la respuesta anterior
curl -X POST https://serverless-rag-assistant.tienvo.workers.dev/ask \
  -H "content-type: application/json" \
  -d '{"question":"¿Y cada cuánto se ejecuta?","conversationId":"<id de la respuesta anterior>"}'

# 2b) Modo razonamiento (opcional): DeepSeek-R1 piensa antes de responder y devuelve su razonamiento
curl -X POST "https://serverless-rag-assistant.tienvo.workers.dev/ask?reasoning=true" \
  -H "content-type: application/json" \
  -d '{"question":"..."}'
```

**Dos modos de respuesta**: la respuesta indica cuál corrió (`mode`).

| | `fast` (por defecto) | `reasoning` (`"reasoning": true` o `?reasoning=true`) |
|---|---|---|
| Modelo | `llama-3.3-70b-instruct-fp8-fast` | `deepseek-r1-distill-qwen-32b` |
| Latencia | ~1-3 s | ~10-30 s |
| Ideal para | consultas directas | preguntas que combinan varios datos |
| Salida extra | — | `reasoning` (el paso a paso del modelo) |

El razonamiento es opcional porque es más lento y costoso: en pruebas, una respuesta razonada tardó ~9 s y usó ~110 de las 10.000 neuronas gratis diarias de Workers AI. Si R1 falla o se queda sin tokens, `/ask` igual responde con el modelo rápido y agrega `fallback: true`.

**Cómo se lee una URL:** primero con Jina Reader (mejor formato). Si el lector falla — limita por IP y las IPs de salida de Cloudflare son compartidas, así que `429 Per IP rate limit exceeded` es común — el Worker descarga la página él mismo y le quita el HTML. La respuesta indica qué camino se usó (`read_with: "reader" | "direct"`). El secreto opcional `JINA_API_KEY` (plan gratis) sube el límite del lector: `wrangler secret put JINA_API_KEY`.

**Cómo se fragmenta un documento:** no cada 800 caracteres, sino según la estructura del propio documento. El texto se parte en títulos, párrafos, viñetas, filas de tabla, bloques de código y oraciones, y esas piezas se empacan en fragmentos de hasta 1000 caracteres (380-590 en promedio, según la página) con un solapamiento corto de oraciones completas. Así un fragmento nunca termina a mitad de una oración, nunca mezcla dos secciones y empieza con la ruta de títulos de la que salió (`# Página > Sección`), de modo que un fragmento recuperado dice de qué habla. Es puro procesamiento de texto: ninguna llamada extra de embeddings, ningún consumo extra de Workers AI. Medido sobre tres páginas reales de documentación, los fragmentos que empezaban a mitad de una oración pasaron de 13/16 a 0, las palabras partidas entre dos fragmentos de 10 a 0 y los fragmentos que mezclaban dos secciones de 11 a 0, con 10% más de caracteres indexados (`npm run test:unit` imprime la tabla). Como los fragmentos son más pequeños, `/ask` ahora recupera 8 por defecto en vez de 5, para dejarle al modelo la misma cantidad de contexto (`topK` en el cuerpo de la petición lo sigue pudiendo cambiar).

Los endpoints de ingesta tienen rate limit por IP, solo aceptan páginas públicas http(s) e indexan como máximo 100 fragmentos (~50 mil caracteres) por petición (`truncated: true` si la página es más larga). Se activan con `wrangler secret put INGEST_TOKEN`; sin el secreto responden 503.

### Documentos grandes (Cloudflare Workflows)

Para páginas o textos que superan el tope de 100 fragmentos, `POST /ingest-jobs` inicia un **Workflow** durable y responde `202` con un id de trabajo. El trabajo lee la página (si es por URL) y luego vectoriza y guarda en lotes de 50 fragmentos; cada lote es un paso que se reintenta con backoff exponencial, así un error de Workers AI o Vectorize no reinicia todo el documento. Los ids de los vectores salen del trabajo y la posición del fragmento, por lo que un lote reintentado sobrescribe sus propios vectores en vez de duplicarlos. Un trabajo indexa hasta 1000 fragmentos (~500 mil caracteres, el tope de Jina Reader); el texto enviado directo tiene un máximo de 900 KiB (el payload de un Workflow está limitado a 1 MiB). Mismo token y rate limit que los otros endpoints de ingesta. En el plan Workers Free el estado de un trabajo terminado se conserva 3 días.

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

### Memoria de conversación (D1)

Con el binding opcional `DB` (Cloudflare D1), `/ask` recuerda los **últimos 5 turnos de pregunta y respuesta** de una conversación, así funcionan seguimientos como "¿y cada cuánto se ejecuta?". Cada respuesta devuelve un `conversationId`; reenvíalo en la siguiente petición (la página demo lo hace durante la sesión de la página). Sin id empieza una conversación nueva; un id mal formado devuelve 400. Sin el binding, o si D1 no está disponible, `/ask` sigue sin estado y responde como antes.

Privacidad y retención, porque la demo es pública:
- Por mensaje se guarda: id de conversación, rol, texto (máximo 2.000 caracteres) y fecha. **Sin dirección IP**, user agent ni otros datos de la petición.
- Los mensajes con más de **7 días** se borran en cada escritura, y cada conversación guarda como máximo 10 mensajes.
- Quien tenga un `conversationId` puede continuar esa conversación: no compartas ids ni escribas datos personales en la demo.

Configuración (una vez): `npx wrangler d1 create rag-memory`, pega el `database_id` que devuelve en `wrangler.jsonc` y luego `npx wrangler d1 migrations apply rag-memory --remote`.

**Puntos clave:**
- **Anti-alucinación** — responde "no sé" cuando la respuesta no está en tus documentos (guardarraíl por prompt engineering).
- **Multilingüe** — responde en el idioma en que preguntes.
- **Trazabilidad de fuente** — cada respuesta indica de qué documento salió, con su puntaje de similitud.
- **~$0 de infraestructura** — serverless, sin servidor ni base de datos que alojar.

## Pruebas

En CI corren dos suites en cada push y pull request:

| Suite | Comando | Qué cubre |
|---|---|---|
| Unitarias | `npm run test:unit` | `node:test` con bindings falsos: fragmentación, validación de URL, lectura con Jina Reader, respaldos de modelo, modo razonamiento |
| Runtime | `npm run test:workers` | Vitest dentro de **workerd** (`@cloudflare/vitest-plugin`) con los bindings de `wrangler.jsonc`: rutas, validación de `/ask`, autenticación de ingesta (401/503), el simulador local de rate limit (429), memoria de conversación sobre D1 local con las migraciones reales, el Workflow de ingesta de punta a punta (reintentos por paso, ids deterministas, endpoint de estado) |

`npm test` corre ambas. Workers AI y Vectorize no tienen simulador local, así que la suite de runtime usa `remoteBindings: false` y los simula con `vi.spyOn`: las pruebas nunca tocan una cuenta de Cloudflare ni necesitan credenciales.

---

> Hecho por **Juan Berrio** — Cloud &amp; Data Engineer. Portafolio: [juanberrio0399.github.io](https://juanberrio0399.github.io)

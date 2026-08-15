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

## Resumen del Caso de Estudio

- **Problema**: Construir sistemas RAG seguros y de baja latencia sin gestionar servidores ni incurrir en costes fijos de infraestructura.
- **Solución**: Un pipeline RAG completamente serverless apalancado en el ecosistema edge de Cloudflare (Workers AI, Vectorize, R2).
- **Decisiones de Ingeniería**: Computación edge para minimizar latencia, separación de la base vectorial frente al almacenamiento no estructurado, y robustos guardarraíles mediante prompt engineering contra alucinaciones.
- **Resultados**: Coste de infraestructura en reposo ~$0, arquitectura 100% serverless y alta determinabilidad en las respuestas.

## Qué es

Un servicio **RAG** (Generación Aumentada por Recuperación): recupera los fragmentos más relevantes de tus documentos y deja que un LLM responda **con base en ellos**, en lugar de adivinar. Construido como demostración de **desplegar y operar IA sobre infraestructura cloud**.

## Arquitectura (todo serverless)


        ┌─────────── INGESTA ──────────┐        ┌────────── PREGUNTA ─────┐
Docs →  trozos → embeddings → Vectorize   |  pregunta → embedding → Vectorize
        (Workers AI)   (base vectorial)    |          (búsqueda top-K)
                                          |                 │
                                          |     fragmentos relevantes + pregunta
                                          |                 ▼
                                          |     Workers AI (LLM) → respuesta


| Pieza | Servicio Cloudflare | Rol |
|---|---|---|
| API / cerebro | **Worker** | recibe la petición y orquesta |
| Modelos de IA | **Workers AI** | embeddings + el LLM que responde |
| Base vectorial | **Vectorize** | guarda y busca los vectores |
| Almacenamiento | **R2** | guarda los documentos originales |

## Tecnologías / habilidades demostradas

`Cloudflare Workers` · `Workers AI` · `Vectorize` · `R2` · `RAG` · `Integración de LLM` · `embeddings` · `Infraestructura como código (Terraform, Wrangler)` · `serverless` · `CI/CD`

## Demo en vivo

> **TODO:** Redesplegar este Worker bajo la cuenta y subdominio personal de Juan Berrio en Cloudflare y actualizar esta URL.

🟢 **Pruébalo en el navegador — sin terminal:** https://<TU-SUBDOMINIO>.workers.dev

El propio Worker sirve una pequeña **interfaz web** (HTML/JS vanilla, sin build): eliges una pregunta de ejemplo, pulsas **Obtener respuesta** y ves la respuesta fundamentada **con su documento fuente y los puntajes de similitud** en un clic. Un panel *Avanzado* permite ingerir tu propio documento (protegido por token — tú lo pegas, nada se guarda en la página).

![Serverless RAG Assistant — demo en el navegador: preguntar y obtener una respuesta fundamentada con fuentes y puntajes de similitud](docs/demo.gif)

<!-- El GIF de arriba se graba aparte (el binario no se incluye en este cambio de código). Ver docs/DEMO.md para el guion de grabación de ~20s. Hasta que se agregue, el enlace de la imagen estará roto — es lo esperado en esta rama. -->

> *Grabación del GIF pendiente — ver [`docs/DEMO.md`](docs/DEMO.md) para el flujo exacto ingerir → preguntar → respuesta a capturar.*

<details>
<summary><b>¿Prefieres la terminal?</b> Lo mismo con <code>curl</code> (referencia secundaria)</summary>

bash
# 1) Enseñarle un documento  (la ingesta está protegida por token)
curl -X POST https://<TU-SUBDOMINIO>.workers.dev/ingest \
  -H "content-type: application/json" \
  -H "authorization: Bearer <TU_INGEST_TOKEN>" \
  -d '{"text":"El texto de tu documento aquí...","source":"mi-doc"}'

# 2) Preguntar (con base en tus documentos — espera ~10s tras ingerir)
curl -X POST https://<TU-SUBDOMINIO>.workers.dev/ask \
  -H "content-type: application/json" \
  -d '{"question":"..."}'


</details>

**Puntos clave:**
- **Anti-alucinación** — responde "no sé" cuando la respuesta no está en tus documentos (guardarraíl por prompt engineering).
- **Multilingüe** — responde en el idioma en que preguntes.
- **Trazabilidad de fuente** — cada respuesta indica de qué documento salió, con su puntaje de similitud.
- **~$0 de infraestructura** — serverless, sin servidor ni base de datos que alojar.

---

> Hecho por **Juan Berrio** — Cloud &amp; Data Engineer. Explora mi portafolio y CV completo en [juanberrio0399.github.io](https://juanberrio0399.github.io).

## Licencia
Este proyecto está bajo la Licencia Apache-2.0. Cualquier reutilización de este código debe conservar el aviso de copyright y la atribución a Juan Berrio. Consulta el archivo [LICENSE](./LICENSE) para más detalles.

// Serverless RAG Assistant — Cloudflare Worker
// -------------------------------------------------
// Endpoints:
//   GET  /         → service info
//   POST /ingest   → { text, source } : chunk → embed → store in Vectorize
//   POST /ask      → { question }      : retrieve relevant chunks → LLM answer  (Module 4)

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";      // 768-dim embeddings
const LLM_MODEL = "@cf/meta/llama-3.2-3b-instruct";   // answering model (current, multilingual)
const CHUNK_SIZE = 800;                                // characters per chunk

// Split raw text into fixed-size chunks (small enough for good retrieval).
function chunkText(text, size = CHUNK_SIZE) {
  const clean = text.replace(/\s+/g, " ").trim();
  const chunks = [];
  for (let i = 0; i < clean.length; i += size) {
    chunks.push(clean.slice(i, i + size));
  }
  return chunks;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// POST /ingest  — teach the assistant a document
async function handleIngest(request, env) {
  const { text, source = "manual" } = await request.json().catch(() => ({}));
  if (!text) return json({ error: "Missing 'text' in body." }, 400);

  // 1) Break the document into chunks
  const chunks = chunkText(text);

  // 2) Turn every chunk into an embedding (one AI call for the whole batch)
  const { data: vectors } = await env.AI.run(EMBED_MODEL, { text: chunks });

  // 3) Store each vector in Vectorize, keeping the chunk text as metadata
  const toInsert = chunks.map((chunk, i) => ({
    id: crypto.randomUUID(),
    values: vectors[i],
    metadata: { text: chunk, source },
  }));
  await env.VECTORIZE.insert(toInsert);

  return json({
    ok: true,
    source,
    chunks: chunks.length,
    note: "Vectors take ~5-10s to become queryable (distributed index).",
  });
}

// POST /ask  — answer a question grounded ONLY in the ingested documents
async function handleAsk(request, env) {
  const { question, topK = 5 } = await request.json().catch(() => ({}));
  if (!question) return json({ error: "Missing 'question' in body." }, 400);

  // 1) Embed the question with the SAME model used at ingestion
  const { data } = await env.AI.run(EMBED_MODEL, { text: [question] });

  // 2) Retrieve the most similar chunks (semantic search)
  const results = await env.VECTORIZE.query(data[0], { topK, returnMetadata: "all" });
  const matches = results.matches ?? [];
  if (matches.length === 0) {
    return json({ answer: "No documents ingested yet — add some with /ingest first.", sources: [] });
  }

  // 3) Build the context block from the retrieved chunks
  const context = matches.map((m, i) => `[${i + 1}] ${m.metadata.text}`).join("\n\n");

  // 4) Prompt engineering: force the model to answer ONLY from the context
  const messages = [
    {
      role: "system",
      content:
        "You are a helpful assistant. Answer the question using ONLY the context provided. " +
        "If the answer is not in the context, say you don't know — never make anything up. " +
        "Be concise and reply in the same language as the question.",
    },
    { role: "user", content: `Context:\n${context}\n\nQuestion: ${question}` },
  ];

  const ai = await env.AI.run(LLM_MODEL, { messages });

  return json({
    answer: ai.response,
    sources: [...new Set(matches.map((m) => m.metadata.source))],
    matches: matches.map((m) => ({ score: m.score, source: m.metadata.source })),
  });
}

const INDEX_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Serverless RAG Assistant</title>
<style>
:root{--bg:#0a0e1a;--card:#111a2e;--line:#22314f;--txt:#e6edf7;--mut:#8aa0c2;--acc:#22d3ee}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--txt);display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{max-width:640px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:6px}
h1{font-size:22px;margin:6px 0 4px}.sub{color:var(--mut);font-size:14px;margin:0 0 18px}
.lang button{background:none;border:1px solid var(--line);color:var(--mut);border-radius:8px;padding:4px 9px;cursor:pointer;font-weight:600;font-size:12px}
.lang button.on{background:var(--acc);color:#06101f;border-color:var(--acc)}
textarea{width:100%;background:#0a1526;border:1px solid var(--line);color:var(--txt);border-radius:10px;padding:12px;font-size:15px;resize:vertical;min-height:64px}
button.ask{margin-top:10px;background:var(--acc);color:#06101f;border:none;border-radius:10px;padding:11px 18px;font-weight:700;cursor:pointer;font-size:15px}
.out{margin-top:16px;background:#0a1526;border:1px solid var(--line);border-radius:10px;padding:14px;min-height:46px;font-size:15px;white-space:pre-wrap}
.foot{margin-top:18px;color:var(--mut);font-size:13px}.foot a{color:var(--acc)}
.tag{display:inline-block;font-size:11px;color:var(--acc);border:1px solid var(--line);border-radius:20px;padding:3px 10px}
</style></head><body>
<div class="card">
  <div class="top">
    <span class="tag">Cloudflare Workers AI + Vectorize</span>
    <span class="lang"><button id="bEN" class="on" onclick="L('en')">EN</button><button id="bES" onclick="L('es')">ES</button></span>
  </div>
  <h1>Serverless RAG Assistant</h1>
  <p class="sub" data-en="Ask a question and the AI answers grounded in the ingested documents. 100% serverless on Cloudflare, ~$0 infrastructure." data-es="Haz una pregunta y la IA responde con base en los documentos cargados. 100% serverless en Cloudflare, ~$0 de infraestructura.">Ask a question and the AI answers grounded in the ingested documents. 100% serverless on Cloudflare, ~$0 infrastructure.</p>
  <textarea id="q">How many records does DataForge process?</textarea>
  <button class="ask" onclick="ask()" data-en="Ask" data-es="Preguntar">Ask</button>
  <div class="out" id="out" data-en="The answer will appear here." data-es="La respuesta aparecerá aquí.">The answer will appear here.</div>
  <p class="foot"><span data-en="Demo API. Source code:" data-es="API demo. Código fuente:">Demo API. Source code:</span> <a href="https://github.com/juanberrio0399/serverless-rag-assistant" target="_blank">github.com/juanberrio0399/serverless-rag-assistant</a></p>
</div>
<script>
function L(l){document.documentElement.lang=l;document.querySelectorAll('[data-en]').forEach(function(e){var v=e.getAttribute('data-'+l);if(v)e.textContent=v});document.getElementById('bEN').classList.toggle('on',l==='en');document.getElementById('bES').classList.toggle('on',l==='es')}
async function ask(){var q=document.getElementById('q').value.trim(),o=document.getElementById('out');if(!q)return;o.textContent='...';try{var r=await fetch('/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:q})});var d=await r.json();o.textContent=(d.answer||d.error||'-')+(d.sources&&d.sources.length?'   ['+d.sources.join(', ')+']':'')}catch(e){o.textContent='Error: '+e.message}}
</script></body></html>`;

export default {
  async fetch(request, env) {
   try {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/ingest") {
      return await handleIngest(request, env);
    }
    if (request.method === "POST" && url.pathname === "/ask") {
      return await handleAsk(request, env);
    }

    return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
   } catch (e) {
    return json({ error: e?.message || String(e) }, 500);
   }
  },
};

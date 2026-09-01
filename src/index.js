// Serverless RAG Assistant — Cloudflare Worker
// -------------------------------------------------
// Endpoints:
//   GET  /         → service info
//   POST /ingest   → { text, source } : chunk → embed → store in Vectorize
//   POST /ask      → { question }      : retrieve relevant chunks → LLM answer  (Module 4)

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";      // 768-dim embeddings
const LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct";   // answering model (supports tool use)
const RERANK_MODEL = "@cf/baai/bge-reranker-base";    // cross-encoder reranker (query↔chunk relevance)
const MIN_RERANK_SCORE = 0.4;                          // drop weakly-relevant chunks after reranking

// aiAnswer — Workers AI (free) with a Groq fallback (free, GROQ_API_KEY Worker secret) for quota resilience.
async function aiAnswer(env, messages) {
  const tools = [{
    name: "get_current_time",
    description: "Get the current date and time",
    parameters: { type: "object", properties: {}, required: [] }
  }];

  try {
    let response = await env.AI.run(LLM_MODEL, { messages, tools });
    if (response.tool_calls && response.tool_calls.length > 0) {
      const toolCall = response.tool_calls[0];
      if (toolCall.name === "get_current_time") {
        messages.push(response);
        messages.push({ role: "tool", name: "get_current_time", content: new Date().toISOString() });
        response = await env.AI.run(LLM_MODEL, { messages, tools });
      }
    }
    return (response.response || "").trim();
  } catch (e) { console.error("Workers AI:", e.message); }
  if (env.GROQ_API_KEY) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + env.GROQ_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, temperature: 0.2 }) });
      if (res.ok) { const j = await res.json(); return (j?.choices?.[0]?.message?.content || "").trim(); }
    } catch (e) { console.error("Groq fallback:", e.message); }
  }
  return "";
}
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
  // 0) Rate limit /ask per client IP (protects free Workers AI quota from abuse).
  //    Optional binding: when RATE_LIMITER isn't configured the endpoint stays open.
  if (env.RATE_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") || "anonymous";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return json({ error: "Rate limit exceeded. Please try again later." }, 429);
    }
  }

  const { question, topK = 5 } = await request.json().catch(() => ({}));
  if (!question) return json({ error: "Missing 'question' in body." }, 400);

  // 1) Embed the question with the SAME model used at ingestion
  const { data } = await env.AI.run(EMBED_MODEL, { text: [question] });

  // 2) Retrieve a WIDER candidate pool than we finally use. Reranking only helps
  //    when it has extra candidates to promote/demote, so we over-retrieve here
  //    and let the cross-encoder in step 2b narrow it back down to the best ones.
  const candidateK = Math.max(topK * 3, 12);
  const results = await env.VECTORIZE.query(data[0], { topK: candidateK, returnMetadata: "all" });
  const matches = results.matches ?? [];
  if (matches.length === 0) {
    return json({ answer: "No documents ingested yet — add some with /ingest first.", sources: [] });
  }

  // 2b) Rerank the candidates with a cross-encoder for true query↔chunk relevance
  //     (Vectorize gives approximate vector similarity; the reranker scores the
  //     pair directly and re-orders, lifting precision on noisy corpora).
  //     Output shape: { response: [ { id, score } ] } where `id` indexes into the
  //     contexts we sent. We map each id back to its match and sort by score desc,
  //     drop weakly-relevant chunks, and keep at most topK.
  let ordered = matches;
  try {
    const rr = await env.AI.run(RERANK_MODEL, {
      query: question,
      contexts: matches.map((m) => ({ text: m.metadata.text })),
    });
    const ranking = rr?.response;
    if (Array.isArray(ranking) && ranking.length) {
      const reranked = ranking
        .filter((r) => r && typeof r.id === "number" && matches[r.id])
        .map((r) => ({ ...matches[r.id], rerankScore: r.score }))
        .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
      if (reranked.length) {
        const kept = reranked.filter((m) => (m.rerankScore ?? 0) >= MIN_RERANK_SCORE);
        // Keep at least the top match even if all scores fall below the threshold.
        ordered = (kept.length ? kept : [reranked[0]]).slice(0, topK);
      }
    }
  } catch (err) {
    // Reranker unavailable → fall back to the original Vectorize similarity order.
    ordered = matches.slice(0, topK);
  }

  // 3) Build the context block from the reranked chunks
  const context = ordered.map((m, i) => `[${i + 1}] ${m.metadata.text}`).join("\n\n");

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

  const answer = await aiAnswer(env, messages);

  return json({
    answer,
    sources: [...new Set(ordered.map((m) => m.metadata.source))],
    matches: ordered.map((m) => ({ score: m.score, rerankScore: m.rerankScore, source: m.metadata.source })),
  });
}

const INDEX_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Serverless RAG Assistant</title>
<style>
:root{--bg:#f5f7fa;--card:#ffffff;--ink:#0f172a;--body:#334155;--mut:#64748b;--line:#e6eaf0;--acc:#1d4ed8;--soft:#eef3ff}
*{box-sizing:border-box}
body{margin:0;font-family:"Segoe UI",system-ui,Arial,sans-serif;background:var(--bg);color:var(--body);display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;line-height:1.6}
.card{max-width:680px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:34px;box-shadow:0 12px 44px -22px rgba(15,23,42,.20)}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--acc)}
h1{font-size:24px;color:var(--ink);margin:6px 0}
.sub{color:var(--mut);font-size:15px;margin:0 0 22px}
.lang button{background:#fff;border:1px solid var(--line);color:var(--mut);border-radius:8px;padding:5px 10px;cursor:pointer;font-weight:600;font-size:12px}
.lang button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.label{font-size:13.5px;font-weight:600;color:var(--ink);margin:0 0 9px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.chip{font-size:13px;background:var(--soft);border:1px solid #dbe4ff;color:var(--acc);padding:6px 12px;border-radius:8px;cursor:pointer;transition:background .15s}
.chip:hover{background:#e0e9ff}
textarea{width:100%;background:#fff;border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:12px;font-size:15px;resize:vertical;min-height:58px;font-family:inherit}
button.ask{margin-top:10px;background:var(--acc);color:#fff;border:none;border-radius:10px;padding:11px 22px;font-weight:600;cursor:pointer;font-size:15px}
button.ask:hover{background:#1843b8}
.out{margin-top:16px;background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:15px;min-height:46px;font-size:15px;color:var(--ink);white-space:pre-wrap}
.foot{margin-top:20px;padding-top:15px;border-top:1px solid var(--line);color:var(--mut);font-size:13px}
.foot a{color:var(--acc);text-decoration:none}
</style></head><body>
<div class="card">
  <div class="top">
    <div><div class="eyebrow">Cloud &amp; Data Engineering</div><h1>Serverless RAG Assistant</h1></div>
    <span class="lang"><button id="bEN" class="on" onclick="L('en')">EN</button><button id="bES" onclick="L('es')">ES</button></span>
  </div>
  <p class="sub" data-en="An AI service that answers questions using only the information in the loaded documents, deployed on serverless cloud infrastructure (Cloudflare). It does not invent: if the answer is not in the sources, it says so." data-es="Un servicio de IA que responde preguntas usando unicamente la informacion de los documentos cargados, desplegado sobre infraestructura cloud serverless (Cloudflare). No inventa: si la respuesta no esta en las fuentes, lo indica.">An AI service that answers questions using only the information in the loaded documents, deployed on serverless cloud infrastructure (Cloudflare). It does not invent: if the answer is not in the sources, it says so.</p>
  <p class="label" data-en="This demo is preloaded with a short profile. Select an example question:" data-es="Esta demostracion trae cargado un perfil breve. Selecciona una pregunta de ejemplo:">This demo is preloaded with a short profile. Select an example question:</p>
  <div class="chips" id="chips"></div>
  <textarea id="q"></textarea>
  <button class="ask" onclick="ask()" data-en="Get answer" data-es="Obtener respuesta">Get answer</button>
  <div class="out" id="out" data-en="The answer will appear here, with its source document." data-es="La respuesta aparecera aqui, con su documento fuente.">The answer will appear here, with its source document.</div>
  <p class="foot"><span data-en="Designed and built by Juan Berrio, Cloud &amp; Data Engineer. Source code:" data-es="Disenado y construido por Juan Berrio, Cloud &amp; Data Engineer. Codigo fuente:">Designed and built by Juan Berrio, Cloud &amp; Data Engineer. Source code:</span> <a href="https://github.com/juanberrio0399/serverless-rag-assistant" target="_blank">GitHub</a></p>
</div>
<script>
var EX={en:["How many records does DataForge process?","What technologies does DataForge use?","How often does DataForge run?"],es:["Cuantos registros procesa DataForge?","Que tecnologias usa DataForge?","Cada cuanto se ejecuta DataForge?"]};
function chips(l){var c=document.getElementById("chips");c.innerHTML="";EX[l].forEach(function(t){var b=document.createElement("span");b.className="chip";b.textContent=t;b.onclick=function(){document.getElementById("q").value=t};c.appendChild(b)})}
function L(l){document.documentElement.lang=l;document.querySelectorAll("[data-en]").forEach(function(e){var v=e.getAttribute("data-"+l);if(v)e.textContent=v});document.getElementById("bEN").classList.toggle("on",l==="en");document.getElementById("bES").classList.toggle("on",l==="es");chips(l);document.getElementById("q").value=EX[l][0]}
async function ask(){var q=document.getElementById("q").value.trim(),o=document.getElementById("out");if(!q)return;o.textContent="...";try{var r=await fetch("/ask",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question:q})});var d=await r.json();o.textContent=(d.answer||d.error||"-")+(d.sources&&d.sources.length?"   ["+d.sources.join(", ")+"]":"")}catch(e){o.textContent="Error: "+e.message}}
L("en");
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

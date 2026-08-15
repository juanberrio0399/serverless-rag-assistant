// Serverless RAG Assistant — Cloudflare Worker
// -------------------------------------------------
// Endpoints:
//   GET  /         → service info
//   POST /ingest   → { text, source } : chunk → embed → store in Vectorize
//   POST /ask      → { question }      : retrieve relevant chunks → LLM answer  (Module 4)

// --- Models (Workers AI) --------------------------------------------------
// Defaults kept intentionally: changing EMBED_MODEL alters the vector
// dimension and REQUIRES a full re-ingest of the Vectorize index, so it is
// documented here, not switched. Current alternatives worth an A/B test:
//   LLM:        @cf/zai-org/glm-4.7-flash (fast tool-calling),
//               @cf/openai/gpt-oss-20b (low latency) / -120b (production)
//   Embeddings: @cf/google/embeddinggemma-300m (recent, stronger)
//               ^ swapping this needs a re-ingest (different dimension/index).
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";      // 768-dim embeddings
const LLM_MODEL = "@cf/meta/llama-3.2-3b-instruct";   // answering model (current, multilingual)
const RERANK_MODEL = "@cf/baai/bge-reranker-base";    // cross-encoder reranker (query↔chunk relevance)
const CHUNK_SIZE = 800;                                // characters per chunk
const CHUNK_OVERLAP = 120;                             // chars shared between consecutive chunks (~15%): keeps context across borders, improves recall
const MIN_RERANK_SCORE = 0.4;                          // drop weakly-relevant chunks after reranking

// Split raw text into overlapping chunks. Overlap keeps sentences that fall on
// a chunk boundary retrievable from both sides (better recall). The step is
// `size - overlap`; it is clamped to >= 1 so a mis-set overlap can't loop forever.
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const step = Math.max(1, size - overlap);
  const chunks = [];
  for (let i = 0; i < clean.length; i += step) {
    chunks.push(clean.slice(i, i + size));
    if (i + size >= clean.length) break; // last window already reached the end
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
  const authHeader = request.headers.get("Authorization");
  const expectedToken = env.INGEST_TOKEN;
  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return json({ error: "Unauthorized. Provide a valid 'Authorization: Bearer <token>' header." }, 401);
  }

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

  // 2) Retrieve the most similar chunks (semantic search)
  const results = await env.VECTORIZE.query(data[0], { topK, returnMetadata: "all" });
  const matches = results.matches ?? [];
  if (matches.length === 0) {
    return json({ answer: "No documents ingested yet — add some with /ingest first.", sources: [] });
  }

  // 2b) Rerank the retrieved chunks with a cross-encoder for true query↔chunk
  //     relevance (Vectorize gives approximate vector similarity; the reranker
  //     scores the pair directly and re-orders, lifting precision on noisy corpora).
  //     Verified output shape (Cloudflare workers-types Ai_Cf_Baai_Bge_Reranker_Base_Output):
  //       { response: [ { id, score } ] }
  //     where `id` is the INDEX into the `contexts` we sent and `score` is the
  //     relevance score. We map each id back to its match and sort by score desc.
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
        ordered = kept.length ? kept : [reranked[0]];
      }
    }
  } catch (err) {
    // Reranker unavailable → fall back to the original Vectorize similarity order.
    ordered = matches;
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

  const ai = await env.AI.run(LLM_MODEL, { messages });

  return json({
    answer: ai.response,
    sources: [...new Set(ordered.map((m) => m.metadata.source))],
    // score = reranker relevance when reranking succeeded, else the vector similarity.
    matches: ordered.map((m) => ({ score: m.rerankScore ?? m.score, source: m.metadata.source })),
  });
}

const INDEX_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Serverless RAG Assistant</title>
<style>
:root{--bg:#f5f7fa;--card:#ffffff;--ink:#0f172a;--body:#334155;--mut:#64748b;--line:#e6eaf0;--acc:#1d4ed8;--soft:#eef3ff;--ok:#0f766e}
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
textarea,input.txt{width:100%;background:#fff;border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:12px;font-size:15px;resize:vertical;font-family:inherit}
textarea{min-height:58px}
button.ask{margin-top:10px;background:var(--acc);color:#fff;border:none;border-radius:10px;padding:11px 22px;font-weight:600;cursor:pointer;font-size:15px}
button.ask:hover{background:#1843b8}
button.ask:disabled{opacity:.55;cursor:progress}
.out{margin-top:16px;background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:15px;min-height:46px;font-size:15px;color:var(--ink)}
.out .ans{white-space:pre-wrap}
.out .err{color:#b91c1c}
.srcs{margin-top:12px;padding-top:11px;border-top:1px dashed var(--line);font-size:13px;color:var(--mut)}
.srcs b{color:var(--ink);font-weight:600}
.score{display:inline-block;font-variant-numeric:tabular-nums;background:#ecfdf5;color:var(--ok);border:1px solid #ccece4;border-radius:6px;padding:1px 7px;margin-left:6px;font-size:12px}
details{margin-top:22px;border-top:1px solid var(--line);padding-top:16px}
summary{cursor:pointer;font-size:13.5px;font-weight:600;color:var(--ink);list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"\\25B8 ";color:var(--mut)}
details[open] summary::before{content:"\\25BE ";color:var(--mut)}
.row{display:flex;gap:10px;margin-top:12px}
.row .txt{flex:1}
.hint{font-size:12px;color:var(--mut);margin:6px 0 0}
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
  <button class="ask" id="askBtn" onclick="ask()" data-en="Get answer" data-es="Obtener respuesta">Get answer</button>
  <div class="out" id="out"><span class="ans" data-en="The answer will appear here, with its source document and similarity scores." data-es="La respuesta aparecera aqui, con su documento fuente y los puntajes de similitud.">The answer will appear here, with its source document and similarity scores.</span></div>

  <details id="ing">
    <summary data-en="Advanced: ingest your own document" data-es="Avanzado: ingiere tu propio documento">Advanced: ingest your own document</summary>
    <p class="hint" data-en="Ingestion is token-protected. Paste your INGEST_TOKEN to teach the assistant a new document (nothing is stored in this page)." data-es="La ingesta esta protegida por token. Pega tu INGEST_TOKEN para ensenarle un documento nuevo (nada se guarda en esta pagina).">Ingestion is token-protected. Paste your INGEST_TOKEN to teach the assistant a new document (nothing is stored in this page).</p>
    <textarea id="itext" data-en-ph="Paste document text here..." data-es-ph="Pega el texto del documento aqui..."></textarea>
    <div class="row">
      <input class="txt" id="isrc" data-en-ph="source name (e.g. my-doc)" data-es-ph="nombre de la fuente (ej. mi-doc)"/>
      <input class="txt" id="itok" type="password" placeholder="INGEST_TOKEN"/>
    </div>
    <button class="ask" id="ingBtn" onclick="ingest()" data-en="Ingest" data-es="Ingerir">Ingest</button>
    <div class="out" id="iout" style="display:none"></div>
  </details>

  <p class="foot"><span data-en="Designed and built by Juan Berrio, Cloud &amp; Data Engineer. Source code:" data-es="Disenado y construido por Juan Berrio, Cloud &amp; Data Engineer. Codigo fuente:">Designed and built by Juan Berrio, Cloud &amp; Data Engineer. Source code:</span> <a href="https://github.com/juanberrio0399/serverless-rag-assistant" target="_blank">GitHub</a></p>
</div>
<script>
var LANG="en";
var EX={en:["How many records does DataForge process?","What technologies does DataForge use?","How often does DataForge run?"],es:["Cuantos registros procesa DataForge?","Que tecnologias usa DataForge?","Cada cuanto se ejecuta DataForge?"]};
var T={en:{asking:"Asking...",ingesting:"Ingesting...",err:"Error: ",sources:"Sources",empty:"Type a question first.",noText:"Paste some document text first.",noTok:"Paste your INGEST_TOKEN first.",done:"Ingested "},es:{asking:"Consultando...",ingesting:"Ingiriendo...",err:"Error: ",sources:"Fuentes",empty:"Escribe una pregunta primero.",noText:"Pega el texto de un documento primero.",noTok:"Pega tu INGEST_TOKEN primero.",done:"Ingeridos "}};
function esc(s){return String(s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c]})}
function chips(l){var c=document.getElementById("chips");c.innerHTML="";EX[l].forEach(function(t){var b=document.createElement("span");b.className="chip";b.textContent=t;b.onclick=function(){document.getElementById("q").value=t};c.appendChild(b)})}
function L(l){LANG=l;document.documentElement.lang=l;document.querySelectorAll("[data-en]").forEach(function(e){var v=e.getAttribute("data-"+l);if(v)e.textContent=v});document.querySelectorAll("[data-en-ph]").forEach(function(e){var v=e.getAttribute("data-"+l+"-ph");if(v)e.placeholder=v});document.getElementById("bEN").classList.toggle("on",l==="en");document.getElementById("bES").classList.toggle("on",l==="es");chips(l);document.getElementById("q").value=EX[l][0]}
async function ask(){
  var q=document.getElementById("q").value.trim(),o=document.getElementById("out"),btn=document.getElementById("askBtn");
  if(!q){o.innerHTML='<span class="err">'+T[LANG].empty+'</span>';return}
  btn.disabled=true;o.innerHTML='<span class="ans">'+T[LANG].asking+'</span>';
  try{
    var r=await fetch("/ask",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question:q})});
    var d=await r.json();
    if(!r.ok||d.error){o.innerHTML='<span class="err">'+esc(d.error||("HTTP "+r.status))+'</span>';return}
    var html='<div class="ans">'+esc(d.answer||"-")+'</div>';
    if(d.matches&&d.matches.length){
      html+='<div class="srcs"><b>'+T[LANG].sources+':</b> ';
      html+=d.matches.map(function(m){return esc(m.source)+'<span class="score">'+Number(m.score).toFixed(3)+'</span>'}).join(" ");
      html+='</div>';
    }else if(d.sources&&d.sources.length){
      html+='<div class="srcs"><b>'+T[LANG].sources+':</b> '+esc(d.sources.join(", "))+'</div>';
    }
    o.innerHTML=html;
  }catch(e){o.innerHTML='<span class="err">'+T[LANG].err+esc(e.message)+'</span>'}
  finally{btn.disabled=false}
}
async function ingest(){
  var text=document.getElementById("itext").value.trim(),src=document.getElementById("isrc").value.trim()||"manual",tok=document.getElementById("itok").value.trim();
  var o=document.getElementById("iout"),btn=document.getElementById("ingBtn");
  o.style.display="block";
  if(!text){o.innerHTML='<span class="err">'+T[LANG].noText+'</span>';return}
  if(!tok){o.innerHTML='<span class="err">'+T[LANG].noTok+'</span>';return}
  btn.disabled=true;o.innerHTML='<span class="ans">'+T[LANG].ingesting+'</span>';
  try{
    var r=await fetch("/ingest",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+tok},body:JSON.stringify({text:text,source:src})});
    var d=await r.json();
    if(!r.ok||d.error){o.innerHTML='<span class="err">'+esc(d.error||("HTTP "+r.status))+'</span>';return}
    o.innerHTML='<span class="ans">'+T[LANG].done+d.chunks+' chunk(s) &rarr; "'+esc(d.source)+'". '+esc(d.note||"")+'</span>';
  }catch(e){o.innerHTML='<span class="err">'+T[LANG].err+esc(e.message)+'</span>'}
  finally{btn.disabled=false}
}
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

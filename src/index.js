// Serverless RAG Assistant — Cloudflare Worker
// -------------------------------------------------
// Endpoints:
//   GET  /            → demo page
//   POST /ingest      → { text, source } : chunk → embed → store in Vectorize        (Bearer INGEST_TOKEN)
//   POST /ingest-url  → { url, source? } : Jina Reader → Markdown → same ingestion    (Bearer INGEST_TOKEN)
//   POST /ingest-jobs → { text | url, source? } : large documents, durable Workflow → 202 { id }  (Bearer INGEST_TOKEN)
//   GET  /ingest-jobs/<id> → job status and result                                  (Bearer INGEST_TOKEN)
//   POST /ask         → { question, reasoning?, conversationId? } : retrieve relevant chunks → LLM answer
//                        (reasoning: true or ?reasoning=true → DeepSeek-R1 thinks first; slower, opt-in)
//
// Entry point for wrangler is src/worker.js, which also exports the IngestWorkflow class.

import { EMBED_MODEL, ingestText, cleanSource, parseTargetUrl, readPage, checkIngestToken, isRateLimited } from "./ingest.js";
import { parseJobRequest, jobView, JOB_ID_PATTERN } from "./ingest-jobs.js";
import { wantsReasoning, reasoningAnswer } from "./reasoning.js";
import { resolveConversationId, loadHistory, saveTurn, retrievalQuery } from "./memory.js";
import { looksLikeInjection, buildContext, systemPrompt, leaksSystemPrompt, REFUSAL, INJECTION_REJECTED } from "./guard.js";

// Answering model (supports tool use). llama-3.1-8b-instruct was deprecated on 2026-05-30 and every call failed,
// which left the fast mode answering with an empty string.
export const LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const RERANK_MODEL = "@cf/baai/bge-reranker-base";    // cross-encoder reranker (query↔chunk relevance)
const MIN_RERANK_SCORE = 0.4;                          // drop weakly-relevant chunks after reranking
// Chunks now end on structural boundaries and average ~455 characters instead of ~730, so the
// same number of chunks would give the model a third less context: retrieve a few more of them.
const DEFAULT_TOP_K = 8;

// aiAnswer — Workers AI (free) with a Groq fallback (free, GROQ_API_KEY Worker secret) for quota resilience.
const TIME_QUESTION = /\b(time|date|today|now|hora|fecha|hoy|ahora)\b/i;

async function aiAnswer(env, messages) {
  // Offer the clock tool only when the question is about the date or time: with tools always attached,
  // llama-3.3 answers ordinary questions with "I don't know the function to call".
  const question = messages.at(-1)?.content?.split("Question:").pop() ?? "";
  const tools = TIME_QUESTION.test(question) ? [{
    name: "get_current_time",
    description: "Get the current date and time",
    parameters: { type: "object", properties: {}, required: [] }
  }] : undefined;

  try {
    let response = await env.AI.run(LLM_MODEL, tools ? { messages, tools } : { messages });
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
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

const INDEXING_NOTE = "Vectors take ~5-10s to become queryable (distributed index).";

// Ingestion changes what the public demo answers, so it is rate limited and requires the owner's token.
async function guardIngest(request, env) {
  if (await isRateLimited(request, env, "ingest")) {
    return json({ error: "Rate limit exceeded. Please try again later." }, 429);
  }
  const auth = await checkIngestToken(request, env);
  if (auth === "disabled") return json({ error: "Ingestion is disabled. Set the INGEST_TOKEN secret to enable it." }, 503);
  if (auth !== "ok") return json({ error: "Missing or invalid token." }, 401, { "www-authenticate": "Bearer" });
  return null;
}

// POST /ingest  — teach the assistant a document
async function handleIngest(request, env) {
  const denied = await guardIngest(request, env);
  if (denied) return denied;

  const { text, source } = await request.json().catch(() => ({}));
  if (typeof text !== "string" || !text.trim()) return json({ error: "Missing 'text' in body." }, 400);

  const src = cleanSource(source);
  const result = await ingestText(env, text, src);
  return json({ ok: true, source: src, ...result, note: INDEXING_NOTE });
}

// POST /ingest-url  — teach the assistant a web page (read as Markdown through Jina Reader)
async function handleIngestUrl(request, env) {
  const denied = await guardIngest(request, env);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const target = parseTargetUrl(body.url);
  if (target.error) return json({ error: target.error }, 400);

  // The reader is rate limited per IP and Cloudflare egress IPs are shared, so fall back to
  // fetching the page directly. JINA_API_KEY (optional secret) raises the reader's limit.
  const page = await readPage(target.url, { apiKey: env.JINA_API_KEY });
  if (page.error) return json({ error: page.error }, page.status);
  if (!page.text.replace(/^# .*$/m, "").trim()) return json({ error: "The page has no readable text." }, 422);

  const src = cleanSource(body.source, target.url);
  const result = await ingestText(env, page.text, src);
  return json({ ok: true, url: target.url, source: src, read_with: page.via, ...result, note: INDEXING_NOTE });
}

// POST /ingest-jobs  — large documents: start a durable IngestWorkflow and return its id right away
async function handleIngestJob(request, env) {
  const denied = await guardIngest(request, env);
  if (denied) return denied;
  if (!env.INGEST_WORKFLOW) return json({ error: "Large-document ingestion is not configured." }, 503);

  const job = parseJobRequest(await request.json().catch(() => ({})));
  if (job.error) return json({ error: job.error }, job.status);

  const instance = await env.INGEST_WORKFLOW.create({ params: job.params });
  return json({
    ok: true,
    ...jobView(instance.id, await instance.status()),
    statusUrl: `/ingest-jobs/${instance.id}`,
    note: INDEXING_NOTE,
  }, 202);
}

// GET /ingest-jobs/<id>  — progress of a large-document job
async function handleIngestJobStatus(request, env, id) {
  const denied = await guardIngest(request, env);
  if (denied) return denied;
  if (!env.INGEST_WORKFLOW) return json({ error: "Large-document ingestion is not configured." }, 503);
  if (!JOB_ID_PATTERN.test(id)) return json({ error: "Invalid job id." }, 400);

  let instance;
  try {
    instance = await env.INGEST_WORKFLOW.get(id);
  } catch {
    return json({ error: "Job not found." }, 404);
  }
  return json(jobView(id, await instance.status()));
}

// POST /ask  — answer a question grounded ONLY in the ingested documents
async function handleAsk(request, env, ctx) {
  // 0) Rate limit /ask per client IP (protects free Workers AI quota from abuse).
  //    Optional binding: when RATE_LIMITER isn't configured the endpoint stays open.
  if (await isRateLimited(request, env, "ask")) {
    return json({ error: "Rate limit exceeded. Please try again later." }, 429);
  }

  const body = await request.json().catch(() => ({}));
  const { question, topK = DEFAULT_TOP_K } = body;
  if (!question) return json({ error: "Missing 'question' in body." }, 400);
  // 0a) Direct prompt injection: reject before spending the embedding, reranker and LLM calls
  //     (~55 neurons per question). Detection is deterministic, see src/guard.js.
  if (looksLikeInjection(question)) return json({ error: INJECTION_REJECTED }, 400);
  const reasoning = wantsReasoning(body, new URL(request.url));

  // 0b) Conversation memory (optional D1 binding): last turns of this conversation, oldest first.
  const memory = env.DB ? resolveConversationId(body.conversationId) : null;
  if (memory?.error) return json({ error: memory.error }, 400);
  const history = memory ? await loadHistory(env.DB, memory.id) : [];
  const conversation = memory ? { conversationId: memory.id } : {};
  const query = retrievalQuery(question, history);

  // 1) Embed the question with the SAME model used at ingestion
  const { data } = await env.AI.run(EMBED_MODEL, { text: [query] });

  // 2) Retrieve a WIDER candidate pool than we finally use. Reranking only helps
  //    when it has extra candidates to promote/demote, so we over-retrieve here
  //    and let the cross-encoder in step 2b narrow it back down to the best ones.
  const candidateK = Math.max(topK * 3, 12);
  const results = await env.VECTORIZE.query(data[0], { topK: candidateK, returnMetadata: "all" });
  const matches = results.matches ?? [];
  if (matches.length === 0) {
    return json({ answer: "No documents ingested yet — add some with /ingest first.", ...conversation, sources: [] });
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
      query,
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

  // 3) Build the context block from the reranked chunks. The chunks are sanitized again here —
  //    the index still holds documents ingested before the ingestion-time cleaning existed — and
  //    fenced, so the model can tell document text from the operator's instructions.
  const context = buildContext(ordered.map((m) => m.metadata.text));

  // 4) Prompt engineering: answer ONLY from the context, and never obey what the context says.
  const system = systemPrompt({ hasHistory: history.length > 0 });
  const messages = [
    { role: "system", content: system },
    ...history,
    { role: "user", content: `Context:\n${context.block}\n\nQuestion: ${question}` },
  ];

  // 5) Opt-in reasoning mode; if R1 fails or runs out of tokens, answer with the fast model instead.
  let reasoned = reasoning ? await reasoningAnswer(env, messages) : null;
  let answer = reasoned ? reasoned.answer : await aiAnswer(env, messages);

  // 6) If the fast model returned nothing (outage, deprecated model), try the reasoning model before
  //    handing back a blank answer.
  let rescued = false;
  if (!answer && !reasoning) {
    reasoned = await reasoningAnswer(env, messages);
    if (reasoned) { answer = reasoned.answer; rescued = true; }
  }

  // 6b) Output check: if an injection got through anyway and the answer repeats the system prompt,
  //     hand back a refusal instead. String comparison only, no second model call.
  const sanitizedContext = Object.values(context.removed).some((n) => n > 0);
  const guardNotes = sanitizedContext ? ["context-sanitized"] : [];
  if (answer && leaksSystemPrompt(answer, system)) {
    answer = REFUSAL;
    guardNotes.push("answer-redacted");
  }

  // 7) Remember this turn after responding (only answered turns are stored).
  if (memory && answer) {
    const saving = saveTurn(env.DB, memory.id, question, answer);
    if (ctx?.waitUntil) ctx.waitUntil(saving); else await saving;
  }

  return json({
    answer,
    ...conversation,
    mode: reasoned ? "reasoning" : "fast",
    ...(reasoned ? { reasoning: reasoned.reasoning } : {}),
    ...((reasoning && !reasoned) || rescued ? { fallback: true } : {}),
    ...(guardNotes.length ? { guarded: guardNotes, ...(sanitizedContext ? { removedFromContext: context.removed } : {}) } : {}),
    ...(answer ? {} : { error: "No model returned an answer. Please try again in a moment." }),
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
.rsn{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13.5px;color:var(--mut);cursor:pointer}
.why{margin-top:10px;font-size:13.5px}
.why summary{cursor:pointer;color:var(--acc);font-weight:600}
#whyTxt{white-space:pre-wrap;margin-top:8px;background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:12px;max-height:280px;overflow:auto;color:var(--body)}
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
  <label class="rsn"><input type="checkbox" id="rsn"> <span data-en="Reason step by step (slower, ~10-30 s)" data-es="Razonar paso a paso (mas lento, ~10-30 s)">Reason step by step (slower, ~10-30 s)</span></label>
  <button class="ask" onclick="ask()" data-en="Get answer" data-es="Obtener respuesta">Get answer</button>
  <div class="out" id="out" data-en="The answer will appear here, with its source document." data-es="La respuesta aparecera aqui, con su documento fuente.">The answer will appear here, with its source document.</div>
  <details class="why" id="why" hidden><summary data-en="How it reasoned" data-es="Como razono">How it reasoned</summary><div id="whyTxt"></div></details>
  <p class="foot"><span data-en="Designed and built by Juan Berrio, Cloud &amp; Data Engineer. Source code:" data-es="Disenado y construido por Juan Berrio, Cloud &amp; Data Engineer. Codigo fuente:">Designed and built by Juan Berrio, Cloud &amp; Data Engineer. Source code:</span> <a href="https://github.com/juanberrio0399/serverless-rag-assistant" target="_blank">GitHub</a></p>
</div>
<script>
var EX={en:["How many records does DataForge process?","What technologies does DataForge use?","How often does DataForge run?"],es:["Cuantos registros procesa DataForge?","Que tecnologias usa DataForge?","Cada cuanto se ejecuta DataForge?"]};
function chips(l){var c=document.getElementById("chips");c.innerHTML="";EX[l].forEach(function(t){var b=document.createElement("span");b.className="chip";b.textContent=t;b.onclick=function(){document.getElementById("q").value=t};c.appendChild(b)})}
function L(l){document.documentElement.lang=l;document.querySelectorAll("[data-en]").forEach(function(e){var v=e.getAttribute("data-"+l);if(v)e.textContent=v});document.getElementById("bEN").classList.toggle("on",l==="en");document.getElementById("bES").classList.toggle("on",l==="es");chips(l);document.getElementById("q").value=EX[l][0]}
var CID;
async function ask(){var q=document.getElementById("q").value.trim(),o=document.getElementById("out"),w=document.getElementById("why"),rs=document.getElementById("rsn").checked;if(!q)return;o.textContent=rs?"... (reasoning, ~10-30 s)":"...";w.hidden=true;try{var r=await fetch("/ask",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question:q,reasoning:rs,conversationId:CID})});var d=await r.json();if(d.conversationId)CID=d.conversationId;o.textContent=(d.answer||d.error||"-")+(d.sources&&d.sources.length?"   ["+d.sources.join(", ")+"]":"")+(d.fallback?"   (reasoning unavailable, fast answer)":"");if(d.reasoning){document.getElementById("whyTxt").textContent=d.reasoning;w.hidden=false}}catch(e){o.textContent="Error: "+e.message}}
L("en");
</script></body></html>`;

export default {
  async fetch(request, env, ctx) {
   try {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/ingest") {
      return await handleIngest(request, env);
    }
    if (request.method === "POST" && url.pathname === "/ingest-jobs") {
      return await handleIngestJob(request, env);
    }
    if (request.method === "GET" && url.pathname.startsWith("/ingest-jobs/")) {
      return await handleIngestJobStatus(request, env, url.pathname.slice("/ingest-jobs/".length));
    }
    if (request.method === "POST" && url.pathname === "/ingest-url") {
      return await handleIngestUrl(request, env);
    }
    if (request.method === "POST" && url.pathname === "/ask") {
      return await handleAsk(request, env, ctx);
    }

    return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
   } catch (e) {
    return json({ error: e?.message || String(e) }, 500);
   }
  },
};

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

    return json({
      name: "Serverless RAG Assistant",
      description: "RAG over your documents, 100% serverless on Cloudflare.",
      endpoints: {
        "POST /ingest": "{ text, source } — add a document",
        "POST /ask": "{ question } — ask grounded in your documents",
      },
    });
   } catch (e) {
    return json({ error: e?.message || String(e) }, 500);
   }
  },
};

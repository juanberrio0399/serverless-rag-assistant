// Serverless RAG Assistant — Cloudflare Worker
// -------------------------------------------------
// Endpoints:
//   GET  /         → service info
//   POST /ingest   → { text, source } : chunk → embed → store in Vectorize
//   POST /ask      → { question }      : retrieve relevant chunks → LLM answer  (Module 4)

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";      // 768-dim embeddings
const LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct";   // answering model
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/ingest") {
      return handleIngest(request, env);
    }
    if (request.method === "POST" && url.pathname === "/ask") {
      return json({ error: "Coming in Module 4 🙂" }, 501);
    }

    return json({
      name: "Serverless RAG Assistant",
      description: "RAG over your documents, 100% serverless on Cloudflare.",
      endpoints: {
        "POST /ingest": "{ text, source } — add a document",
        "POST /ask": "{ question } — ask grounded in your documents",
      },
    });
  },
};

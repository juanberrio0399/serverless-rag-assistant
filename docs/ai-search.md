# Cloudflare AI Search (Managed RAG) Variant

Cloudflare AI Search (anteriormente conocido como AutoRAG) proporciona un pipeline RAG **totalmente gestionado** sobre Cloudflare R2 y Vectorize. A diferencia del pipeline manual de este repositorio (`src/index.js`), AI Search maneja automáticamente:

- Chunking de documentos
- Generación de embeddings
- Re-indexado continuo al actualizar objetos en R2
- Búsqueda híbrida (Vectorial + BM25)
- Reranking y generación con system prompts

## Configuración sobre el Bucket Existente

Apuntando a nuestro bucket R2 existente (`rag-source-docs` definido en `terraform/main.tf`):

1. **Habilitar AI Search / AutoRAG** en el panel de Cloudflare vinculando el bucket R2 `rag-source-docs`.
2. **Binding en Workers (`wrangler.jsonc`)**:
   
   {
     "ai_search": [
       {
         "binding": "AI_SEARCH",
         "bucket": "rag-source-docs"
       }
     ]
   }
   
3. **Consulta desde un Worker**:
   javascript
   export default {
     async fetch(request, env) {
       const url = new URL(request.url);
       const query = url.searchParams.get("q") || "¿Qué es este repo?";
       const results = await env.AI_SEARCH.query(query);
       return Response.json(results);
     }
   };
   

## Referencias Oficiales
- [Cloudflare AI Search Docs](https://developers.cloudflare.com/ai-search/)
- [Release Notes](https://developers.cloudflare.com/ai-search/platform/release-note/)

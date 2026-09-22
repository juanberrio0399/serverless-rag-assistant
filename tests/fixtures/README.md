# Chunking fixtures

Excerpts of three real Cloudflare documentation pages — the kind of page this project
ingests through `/ingest-url` — used by `tests/chunker.test.js` to compare the old fixed-size
chunking with the structure-aware one. They are stored here so the comparison runs offline and
gives the same numbers on every machine and in CI.

| File | Source (fetched as Markdown, front matter and page chrome removed) |
|---|---|
| `cloudflare-vectorize.md` | https://developers.cloudflare.com/vectorize/ |
| `cloudflare-workflows.md` | https://developers.cloudflare.com/workflows/ |
| `cloudflare-workers-ai.md` | https://developers.cloudflare.com/workers-ai/ |

© Cloudflare, Inc. Cloudflare's documentation is published under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); these excerpts are redistributed
under the same licence.

# Recording the demo GIF (`docs/demo.gif`)

The README embeds `docs/demo.gif`. The binary is **not** committed by the code
change — record it once and drop the file here so the image resolves.

## What the Worker serves

The Worker (`src/index.js`) serves a small web UI at `/` (no build step, vanilla
HTML/JS). It exposes:

- **Ask** — example-question chips + a textarea → `POST /ask`; renders the
  answer with its **source documents** and **similarity scores**, plus an
  `Asking…` / `Consultando…` loading state and inline error handling.
- **Advanced → ingest** — textarea + `source` + an `INGEST_TOKEN` field →
  `POST /ingest`. The token is typed by the user and never stored in the page.

## Suggested 15–20s capture (ingest → ask → answer)

1. Open the live URL (or `npm run dev` locally).
2. Click a preloaded example question and hit **Get answer** — show the answer
   appearing with its **sources + similarity scores**.
3. (Optional) Open **Advanced: ingest your own document**, paste a short text +
   `source` + your `INGEST_TOKEN`, click **Ingest**, show the success line.
4. Ask a question about the freshly ingested text and show the grounded answer.

Keep the `INGEST_TOKEN` off-screen (or blur it) so no secret is captured.

## Tools

- **ScreenToGif** (Windows) or **Peek** (Linux) — record the browser region.
- Target ~800px wide, ≤ 6 MB, loop enabled.
- Save as `docs/demo.gif` and commit **only** the GIF.

Nothing else in the repo needs to change once the GIF is in place.

// Worker entry point (wrangler.jsonc "main"): the HTTP handler plus the Workflow class.
// Kept apart from src/index.js because `cloudflare:workers` only exists in the Workers runtime,
// so the node:test suite can keep importing the handler directly.
export { default } from "./index.js";
export { IngestWorkflow } from "./workflow.js";

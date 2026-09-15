// IngestWorkflow: durable ingestion started by POST /ingest-jobs (see src/ingest-jobs.js).
// Steps: read the page (URL jobs only) → one "embed and store" step per 50-chunk batch.
// A failed step is retried with backoff without repeating the batches that already finished.

import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { STEP_CONFIG, readDocument, planBatches, embedAndStoreBatch } from "./ingest-jobs.js";

export class IngestWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const params = event.payload;

    const text = params.url
      ? await step.do("read page", STEP_CONFIG, async () => {
          try {
            return await readDocument(params);
          } catch (e) {
            throw e.permanent ? new NonRetryableError(e.message) : e;
          }
        })
      : params.text;

    const plan = planBatches(text);
    if (plan.chunks === 0) throw new NonRetryableError("The document has no text.");

    let stored = 0;
    for (const [n, batch] of plan.batches.entries()) {
      stored += await step.do(`embed and store batch ${n + 1} of ${plan.batches.length}`, STEP_CONFIG, () =>
        embedAndStoreBatch(this.env, event.instanceId, params.source, batch.offset, batch.chunks),
      );
    }

    return {
      source: params.source,
      ...(params.url ? { url: params.url } : {}),
      chunks: stored,
      totalChunks: plan.totalChunks,
      truncated: plan.truncated,
    };
  }
}

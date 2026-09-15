// Runtime tests: they run inside workerd (the real Workers runtime) through @cloudflare/vitest-plugin.
// The node:test suite in tests/*.test.js stays as the fast unit layer (`npm run test:unit`).
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const TEST_INGEST_TOKEN = "test-ingest-token"; // tests/workers/worker.spec.js uses the same value

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Workers AI and Vectorize have no local simulator: never reach the Cloudflare account from tests.
      // Their calls are mocked per test with vi.spyOn on env.AI / env.VECTORIZE.
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { INGEST_TOKEN: TEST_INGEST_TOKEN },
      },
    }),
  ],
  test: {
    include: ["tests/workers/**/*.spec.js"],
  },
});

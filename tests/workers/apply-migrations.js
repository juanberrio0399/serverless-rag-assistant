// Applies migrations/ to the local D1 database before the runtime tests.
// Safe to run more than once: applyD1Migrations skips migrations that are already applied.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

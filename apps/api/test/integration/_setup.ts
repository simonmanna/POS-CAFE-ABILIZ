/**
 * D5-1: integration test scaffolding. These specs run against a live Postgres
 * (DATABASE_URL must be reachable). They exercise the full request → DB →
 * response path for the money flows that a POS / cashier must hit during a
 * real shift.
 *
 * Skipped when no DATABASE_URL is configured for local unit-only runs; release
 * and CI runs fail instead (REQUIRE_DB_TESTS=1 / CI=true). In CI we run
 * `docker compose up -d db` then `pnpm test:integration`.
 */
const HAS_DB = !!process.env.DATABASE_URL;
// Release/CI runs set REQUIRE_DB_TESTS=1: a missing database is then a hard
// failure, never a silently green suite with every money test skipped.
if (!HAS_DB && (process.env.REQUIRE_DB_TESTS === '1' || process.env.CI === 'true')) {
  throw new Error('DATABASE_URL is required: DB-backed financial suites must run in release/CI (REQUIRE_DB_TESTS=1)');
}
const describeDb = HAS_DB ? describe : describe.skip;

export { describeDb };
export const skipIfNoDb = (name: string, fn: () => void | Promise<void>) =>
  HAS_DB ? fn() : Promise.resolve();
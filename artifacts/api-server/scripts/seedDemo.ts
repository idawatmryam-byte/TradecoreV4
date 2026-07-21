/**
 * TradeCore Pro — Demo account seeder (CLI wrapper)
 *
 * Creates or REFRESHES the shared read-only demo account and re-seeds all of
 * its data. The seeding logic lives in src/lib/demoSeed.ts (also called on
 * server startup via ensureDemoAccount); this is just the command-line entry
 * point that runs a full fresh re-seed and exits.
 *
 * Run:  DATABASE_URL=... pnpm --filter @workspace/api-server run seed:demo
 */
import { seedDemoAccount } from "../src/lib/demoSeed";

seedDemoAccount()
  .then((userId) => {
    console.log(`Demo account seeded (user id=${userId}): crypto + forex trades, decisions, hourly stats, autopsy, backtests.`);
    process.exit(0);
  })
  .catch((e) => {
    console.error("seedDemo failed:", e);
    process.exit(1);
  });

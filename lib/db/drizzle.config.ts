import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // drizzle-kit only manages `public` unless told otherwise. The append-only
  // capture log lives in its own Postgres schema so its INSERT-only grant can
  // be enforced by the database (scripts/sql/capture-grants.sql) rather than
  // by convention — without this filter those tables are silently never
  // created, and every capture write fails at runtime.
  schemaFilter: ["public", "capture"],
});

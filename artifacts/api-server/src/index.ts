import app from "./app";
import { logger } from "./lib/logger";
import { validateEnv } from "./lib/env";

// app.ts already called validateEnv() at import time (fail fast before
// building any middleware) — this call is free (memoized) and just gets us
// the typed snapshot instead of re-parsing process.env by hand here.
const { port } = validateEnv();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

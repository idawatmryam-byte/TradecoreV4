import app from "./app";
import { logger } from "./lib/logger";
import { validateEnv } from "./lib/env";

// app.ts already called validateEnv() at import time (fail fast before
// building any middleware) — this call is free (memoized) and just gets us
// the typed snapshot instead of re-parsing process.env by hand here.
const { port, host } = validateEnv();

const onListening = (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, host: host ?? "0.0.0.0" }, "Server listening");
};

// Node binds every interface when no host is passed — so the unset case must
// omit the argument entirely rather than pass undefined through.
if (host) {
  app.listen(port, host, onListening);
} else {
  app.listen(port, onListening);
}

import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router, { publicRouter } from "./routes";
import { logger } from "./lib/logger";
import { validateEnv } from "./lib/env";
import { corsMiddleware, securityHeaders } from "./middleware/security";
import { rateLimit } from "./middleware/rateLimit";
import { requireAuth } from "./middleware/auth";

// Fail fast and loud on a misconfigured deploy rather than discovering it
// later — see lib/env.ts for the full rationale and the list of everything
// checked here.
validateEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

// Express sits behind a reverse proxy (VPS nginx / Replit's proxy) in every
// real deployment — without this, req.ip is the proxy's address for every
// request, which silently breaks IP-based rate limiting (everyone shares one
// bucket) and pollutes AUTH_REJECTED/RATE_LIMIT_EXCEEDED logs with a single
// useless IP.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(securityHeaders);
app.use(corsMiddleware());
app.use(cookieParser());
// Body size caps — a trading bot's request bodies are all small config/order
// payloads; there's no legitimate reason for a multi-MB body, and allowing
// one is a cheap DoS vector against a single-process server.
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

// Global rate limit — generous, just a backstop against runaway clients/bugs
// and casual scraping. Login/register have their own much stricter limiter
// below, since they're the unauthenticated endpoints worth brute-forcing or
// abusing for mass account creation.
app.use(
  "/api",
  rateLimit({ name: "global", windowMs: 60_000, max: 300 }),
);

// Public routes — no credentials required. Mounted BEFORE the auth gate.
app.use(
  "/api/auth/login",
  rateLimit({ name: "login", windowMs: 15 * 60_000, max: 10 }),
);
app.use(
  "/api/auth/register",
  rateLimit({ name: "register", windowMs: 15 * 60_000, max: 10 }),
);
app.use("/api", publicRouter);

// Everything else requires a valid session cookie or Basic-auth credentials.
app.use("/api", requireAuth, router);

// Unknown /api/* routes: return a JSON 404 instead of falling through to the SPA.
app.use("/api/{*path}", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Serve the built Vite frontend for all non-API routes.
// Frontend assets are co-located with the server bundle at dist/public/.
// Deployment always places the Vite build output into this directory so
// __dirname (= .../dist/) + "public" resolves correctly in every environment.
const frontendDist = path.resolve(__dirname, "public");

// Cache strategy:
//   index.html          → no-cache (browser must revalidate on every navigation)
//   /assets/*.{js,css}  → immutable 1-year cache (content-hashed by Vite, safe to cache forever)
//   everything else     → 1-hour cache (favicon, robots.txt, etc.)
app.use(
  express.static(frontendDist, {
    setHeaders(res, filePath) {
      if (path.basename(filePath) === "index.html") {
        res.set("Cache-Control", "no-cache, no-store, must-revalidate");
        res.set("Pragma", "no-cache");
        res.set("Expires", "0");
      } else if (path.basename(path.dirname(filePath)) === "assets") {
        // Vite emits all JS/CSS bundles into assets/ with content-hashed filenames.
        // Safe to cache forever — a changed file always gets a new hash → new URL.
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.set("Cache-Control", "public, max-age=3600");
      }
    },
  })
);

// SPA catch-all: browser navigations that don't match a static file get index.html.
// Gated on Accept: text/html so missing JS/CSS assets receive a 404 instead of HTML.
// Express 5 / path-to-regexp v8 requires the named wildcard syntax.
// index.html is always served no-cache so that the browser picks up new hashed
// asset filenames immediately after a deployment.
app.get("/{*path}", (req, res, next) => {
  const accept = req.headers.accept ?? "";
  if (!accept.includes("text/html")) return next();
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.sendFile(path.join(frontendDist, "index.html"));
});

// Global error handler — catches synchronous throws and next(err) calls in
// route handlers. Must be declared last, after all routes, and must have
// exactly 4 arguments so Express recognises it as an error handler.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  logger.error(
    { err, req: { method: req.method, url: req.url } },
    "Unhandled route error",
  );
  if (!res.headersSent) {
    res.status(500).json({ error: message });
  }
});

export default app;

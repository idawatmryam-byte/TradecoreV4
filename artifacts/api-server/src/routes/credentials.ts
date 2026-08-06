import { Router, type IRouter, type Response } from "express";
import {
  getBinanceCredentials,
  getBinanceCredentialsStatus,
  setBinanceCredentials,
  deleteBinanceCredentials,
} from "../lib/binanceCredentials";
import {
  getOandaCredentials,
  getOandaCredentialsStatus,
  setOandaCredentials,
  deleteOandaCredentials,
} from "../lib/oandaCredentials";
import { logger } from "../lib/logger";
import { getOrCreateEngine } from "../lib/engineRegistry";
import {
  actionableConnectionError,
  ConnectionValidationError,
  testBinanceConnection,
  testOandaConnection,
} from "../lib/brokers/connectionTest";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// GET /me/binance-credentials — never returns the plaintext key/secret,
// only whether one is configured and a masked preview (last 4 chars of the
// API key, kept in the clear precisely so this endpoint never needs to
// decrypt anything).
// ---------------------------------------------------------------------------
router.get("/me/binance-credentials", async (req, res): Promise<void> => {
  const status = await getBinanceCredentialsStatus(req.userId!);
  res.json(status);
});

// ---------------------------------------------------------------------------
// PUT /me/binance-credentials — body { apiKey, apiSecret }. Encrypts and
// upserts for the logged-in user only. Any cached Crypto client is invalidated
// and a desired-running engine reconnects before the request completes.
// ---------------------------------------------------------------------------
router.put("/me/binance-credentials", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const apiSecret = typeof body.apiSecret === "string" ? body.apiSecret.trim() : "";

  if (!apiKey || !apiSecret) {
    res.status(400).json({ error: "apiKey and apiSecret are both required" });
    return;
  }

  await setBinanceCredentials(req.userId!, apiKey, apiSecret);
  const engine = getOrCreateEngine(req.userId!, "crypto", { resumeIdleDemo: false });
  try {
    await engine.refreshConnection({
      restartIfDesired: true,
      reason: "Binance credentials changed — invalidating cached provider state",
    });
  } catch (err) {
    const mapped = actionableConnectionError("binance", err);
    logger.warn({ userId: req.userId, code: mapped.code }, "Binance credentials saved but engine reconnect failed");
    res.status(409).json({ error: `Credentials were saved, but the Crypto engine was stopped because reconnection failed. ${mapped.message}` });
    return;
  }
  logger.info({ userId: req.userId }, "Binance credentials updated");
  res.json(await getBinanceCredentialsStatus(req.userId!));
});

// ---------------------------------------------------------------------------
// DELETE /me/binance-credentials — removes the logged-in user's stored
// credentials. Purges cached clients/in-memory references before returning;
// Demo can restart keylessly, while Live is stopped because it cannot safely
// reconnect without credentials.
// ---------------------------------------------------------------------------
router.delete("/me/binance-credentials", async (req, res): Promise<void> => {
  await deleteBinanceCredentials(req.userId!);
  const engine = getOrCreateEngine(req.userId!, "crypto", { resumeIdleDemo: false });
  const config = await engine.loadConfig();
  await engine.refreshConnection({
    // Demo must remain independent of these deleted credentials and may keep
    // running keylessly. Live cannot reconnect without them and is stopped.
    restartIfDesired: config.executionTarget === "demo",
    reason: "Binance credentials removed — purging cached provider state",
  });
  logger.info({ userId: req.userId }, "Binance credentials removed");
  res.json({ configured: false, apiKeyPreview: null, updatedAt: null });
});

// ---------------------------------------------------------------------------
// OANDA credentials (forex section) — same trio, same rules as Binance above:
// GET never decrypts (masked account-id preview only), PUT encrypts+upserts,
// active/cached Forex clients are refreshed with the same lifecycle rules.
// ---------------------------------------------------------------------------
router.get("/me/oanda-credentials", async (req, res): Promise<void> => {
  res.json(await getOandaCredentialsStatus(req.userId!));
});

router.put("/me/oanda-credentials", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const apiToken = typeof body.apiToken === "string" ? body.apiToken.trim() : "";
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";

  if (!apiToken || !accountId) {
    res.status(400).json({ error: "apiToken and accountId are both required" });
    return;
  }

  await setOandaCredentials(req.userId!, apiToken, accountId);
  const engine = getOrCreateEngine(req.userId!, "forex", { resumeIdleDemo: false });
  try {
    await engine.refreshConnection({
      restartIfDesired: true,
      reason: "OANDA credentials changed — invalidating cached provider state",
    });
  } catch (err) {
    const mapped = actionableConnectionError("oanda", err);
    logger.warn({ userId: req.userId, code: mapped.code }, "OANDA credentials saved but engine reconnect failed");
    res.status(409).json({ error: `Credentials were saved, but the Forex engine was stopped because reconnection failed. ${mapped.message}` });
    return;
  }
  logger.info({ userId: req.userId }, "OANDA credentials updated");
  res.json(await getOandaCredentialsStatus(req.userId!));
});

router.delete("/me/oanda-credentials", async (req, res): Promise<void> => {
  await deleteOandaCredentials(req.userId!);
  const engine = getOrCreateEngine(req.userId!, "forex", { resumeIdleDemo: false });
  const config = await engine.loadConfig();
  await engine.refreshConnection({
    restartIfDesired: config.executionTarget === "demo",
    reason: "OANDA credentials removed — purging cached provider state",
  });
  logger.info({ userId: req.userId }, "OANDA credentials removed");
  res.json({ configured: false, accountIdPreview: null, updatedAt: null });
});

function connectionTestBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function sendConnectionError(
  res: Response,
  provider: "binance" | "oanda",
  err: unknown,
): void {
  const mapped = err instanceof ConnectionValidationError ? err : actionableConnectionError(provider, err);
  res.status(400).json({ error: mapped.message, code: mapped.code });
}

router.post("/me/binance-credentials/test", async (req, res): Promise<void> => {
  const body = connectionTestBody(req.body);
  const suppliedKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const suppliedSecret = typeof body.apiSecret === "string" ? body.apiSecret.trim() : "";
  if (Boolean(suppliedKey) !== Boolean(suppliedSecret)) {
    res.status(400).json({ error: "Enter both the Binance API key and secret, or leave both blank to test the stored credentials.", code: "CREDENTIAL_PAIR_REQUIRED" });
    return;
  }
  const credentials = suppliedKey
    ? { apiKey: suppliedKey, apiSecret: suppliedSecret }
    : await getBinanceCredentials(req.userId!);
  if (!credentials) {
    res.status(400).json({ error: "No stored Binance credentials are available to test.", code: "CREDENTIALS_MISSING" });
    return;
  }

  const config = await getOrCreateEngine(req.userId!, "crypto", { resumeIdleDemo: false }).loadConfig();
  const marketType = config.marketType === "futures" ? "futures" : "spot";
  try {
    res.json(await testBinanceConnection({ ...credentials, marketType, testnet: config.testnet }));
  } catch (err) {
    sendConnectionError(res, "binance", err);
  }
});

router.post("/me/oanda-credentials/test", async (req, res): Promise<void> => {
  const body = connectionTestBody(req.body);
  const suppliedToken = typeof body.apiToken === "string" ? body.apiToken.trim() : "";
  const suppliedAccountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  if (Boolean(suppliedToken) !== Boolean(suppliedAccountId)) {
    res.status(400).json({ error: "Enter both the OANDA token and account ID, or leave both blank to test the stored credentials.", code: "CREDENTIAL_PAIR_REQUIRED" });
    return;
  }
  const credentials = suppliedToken
    ? { token: suppliedToken, accountId: suppliedAccountId }
    : await getOandaCredentials(req.userId!);
  if (!credentials) {
    res.status(400).json({ error: "No stored OANDA credentials are available to test.", code: "CREDENTIALS_MISSING" });
    return;
  }

  const config = await getOrCreateEngine(req.userId!, "forex", { resumeIdleDemo: false }).loadConfig();
  try {
    res.json(await testOandaConnection({ ...credentials, practice: config.testnet }));
  } catch (err) {
    sendConnectionError(res, "oanda", err);
  }
});

export default router;

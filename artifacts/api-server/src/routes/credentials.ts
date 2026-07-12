import { Router, type IRouter } from "express";
import {
  getBinanceCredentialsStatus,
  setBinanceCredentials,
  deleteBinanceCredentials,
} from "../lib/binanceCredentials";
import { logger } from "../lib/logger";

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
// upserts for the logged-in user only. Restart the bot (if running) for a
// changed credential to take effect — the engine only reads credentials at
// start().
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
  logger.info({ userId: req.userId }, "Binance credentials updated");
  res.json(await getBinanceCredentialsStatus(req.userId!));
});

// ---------------------------------------------------------------------------
// DELETE /me/binance-credentials — removes the logged-in user's stored
// credentials. If their bot is currently running, it keeps using whatever
// exchange connection it already opened until stopped/restarted.
// ---------------------------------------------------------------------------
router.delete("/me/binance-credentials", async (req, res): Promise<void> => {
  await deleteBinanceCredentials(req.userId!);
  logger.info({ userId: req.userId }, "Binance credentials removed");
  res.json({ configured: false, apiKeyPreview: null, updatedAt: null });
});

export default router;

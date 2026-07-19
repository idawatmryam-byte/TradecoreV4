import { Router, type IRouter } from "express";
import { getOrCreateEngine } from "../lib/engineRegistry";

const router: IRouter = Router();

// Live market monitor: real ticker snapshots + exchange connection health.
router.get("/market/live", async (req, res): Promise<void> => {
  res.json(getOrCreateEngine(req.userId!, req.section!).getMarketMonitor());
});

// Recent candles for the dashboard position chart. Public market data, served
// through the engine so the chart uses the SAME feed trades are priced on.
router.get("/market/candles", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const timeframe = ["1m", "3m", "5m", "15m", "1h"].includes(String(req.query.timeframe))
    ? String(req.query.timeframe)
    : "1m";
  const limit = Math.max(20, Math.min(500, Number(req.query.limit) || 180));
  const marketType = req.query.marketType === "futures" ? "futures" : "spot";
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  try {
    const candles = await getOrCreateEngine(req.userId!, req.section!).getRecentCandles(symbol, timeframe, limit, marketType);
    res.json({ symbol, timeframe, candles });
  } catch (err) {
    req.log.warn({ err, symbol }, "Candle fetch for chart failed");
    res.status(502).json({ error: "Could not fetch candles for this symbol" });
  }
});

export default router;

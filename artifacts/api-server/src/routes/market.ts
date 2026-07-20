import { Router, type IRouter } from "express";
import { getOrCreateEngine } from "../lib/engineRegistry";
import {
  isInstrumentOpen,
  nextInstrumentOpen,
  nextInstrumentClose,
  type InstrumentClass,
} from "../lib/marketHours";

const router: IRouter = Router();

// Forex market-hours status — pure calendar math (DST-aware NY 17:00
// boundaries), no OANDA call and no engine needed, so it works even while
// the forex engine is stopped. CURRENCY covers the majors; METAL/CFD add
// the daily one-hour Globex maintenance break (gold, indices).
router.get("/market/forex-hours", (_req, res): void => {
  const now = new Date();
  const classStatus = (cls: InstrumentClass) => {
    const open = isInstrumentOpen(cls, now);
    return {
      open,
      // Only the relevant boundary: when open, the next close; when closed,
      // the next open. Null-padding the other keeps the client trivial.
      nextOpen: open ? null : nextInstrumentOpen(cls, now).toISOString(),
      nextClose: open ? nextInstrumentClose(cls, now).toISOString() : null,
    };
  };
  res.json({
    now: now.toISOString(),
    currency: classStatus("CURRENCY"),
    metalsAndIndices: classStatus("METAL"),
  });
});

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

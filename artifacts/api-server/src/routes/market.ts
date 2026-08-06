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

// Phase 2 observational market perception. Available states contain only
// validated closed candles; blocked entries explain why a state was refused.
// This endpoint is read-only and no consumer feeds it back into execution.
router.get("/market/state", (req, res): void => {
  res.json(getOrCreateEngine(req.userId!, req.section!).getMarketStates());
});

// Recent candles for the dashboard position chart. Public market data, served
// through the engine so the chart uses the SAME feed trades are priced on.
router.get("/market/candles", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const timeframe = ["1m", "3m", "5m", "15m", "1h"].includes(String(req.query.timeframe))
    ? String(req.query.timeframe)
    : "1m";
  const limit = Math.max(20, Math.min(500, Number(req.query.limit) || 180));
  // A forex-section request is ALWAYS marketType=forex — there is no spot/
  // futures distinction there. Deriving from req.section (rather than trusting
  // the query param alone) is what actually matters: previously a caller
  // passing marketType=forex here silently coerced to "spot" (anything not
  // exactly "futures" fell through to it), which sent a forex symbol like
  // EUR_USD to a Binance spot client. Found while wiring the Co-Pilot
  // workspace chart onto this same endpoint — a pre-existing bug in the
  // dashboard's own open-position chart, not something new.
  const marketType = req.section === "forex" ? "forex" : req.query.marketType === "futures" ? "futures" : "spot";
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

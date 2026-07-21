/**
 * TradeCore Pro — Demo account seeder (idempotent)
 *
 * Creates/refreshes the shared READ-ONLY demo account (users.isDemo) and
 * populates BOTH sections with realistic activity so every page of the
 * product is fully alive for a prospect who enters via "Explore the live
 * demo" (POST /auth/demo) — no signup, no exchange keys, no running engine.
 *
 * Seeds: bot_config (crypto + forex), a spread of closed trades (wins,
 * losses, break-even scratches, timeouts) across strategies / symbols /
 * hours, a couple of open positions, post-trade analyses, a decisions
 * journal (executed + reasoned rejections), aggregated hourly_stats, one
 * completed walk-forward Autopsy, and a couple of completed backtests.
 *
 * Idempotent: every run wipes the demo user's rows and re-seeds fresh, so
 * update.sh can call it on every deploy to keep the demo pristine.
 *
 * Run:  DATABASE_URL=... pnpm --filter @workspace/api-server run seed:demo
 */
import { db } from "@workspace/db";
import {
  usersTable, botConfigTable, tradesTable, tradePartialExitsTable,
  strategyDecisionsTable, hourlyStatsTable, tradeAnalysesTable,
  autopsyRunsTable, backtestRunsTable, blacklistTable,
  userBinanceCredentialsTable, userOandaCredentialsTable, strategyConfigsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const DEMO_USERNAME = "demo";

// Deterministic RNG so the demo is identical across re-seeds.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260720);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

type Outcome = "win" | "loss" | "scratch" | "timeout";
interface SymSpec { symbol: string; price: number; stopPct: number; }

interface SectionSpec {
  section: "crypto" | "forex";
  marketType: "spot" | "forex";
  costRate: number;   // per-leg fraction
  riskDollars: number;
  syms: SymSpec[];
  strategies: Array<{ id: string; name: string }>;
  pairs: string;
}

const CRYPTO: SectionSpec = {
  section: "crypto", marketType: "spot", costRate: 0.001, riskDollars: 40,
  syms: [
    { symbol: "BTCUSDT", price: 64200, stopPct: 0.006 },
    { symbol: "ETHUSDT", price: 3380, stopPct: 0.008 },
    { symbol: "SOLUSDT", price: 158, stopPct: 0.011 },
    { symbol: "BNBUSDT", price: 592, stopPct: 0.007 },
  ],
  strategies: [
    { id: "trend_pullback", name: "Trend Pullback" },
    { id: "momentum_breakout", name: "Momentum Breakout" },
    { id: "mean_reversion", name: "Mean Reversion" },
    { id: "vwap_reversion", name: "VWAP Reversion" },
  ],
  pairs: "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LINKUSDT",
};

const FOREX: SectionSpec = {
  section: "forex", marketType: "forex", costRate: 0.0001, riskDollars: 10,
  syms: [
    { symbol: "EUR_USD", price: 1.0850, stopPct: 0.0020 },
    { symbol: "GBP_USD", price: 1.3440, stopPct: 0.0022 },
    { symbol: "AUD_USD", price: 0.7010, stopPct: 0.0025 },
    { symbol: "XAU_USD", price: 2402, stopPct: 0.0035 },
  ],
  strategies: [
    { id: "trend_pullback", name: "Trend Pullback" },
    { id: "mean_reversion", name: "Mean Reversion" },
    { id: "london_breakout", name: "London Breakout" },
    { id: "vwap_reversion", name: "VWAP Reversion" },
  ],
  pairs: "EUR_USD,GBP_USD,AUD_USD,NZD_USD,XAU_USD",
};

interface GenTrade {
  section: string; symbol: string; side: "buy" | "sell"; strategyId: string; strategyName: string;
  entryPrice: number; exitPrice: number | null; quantity: number; plannedStopLoss: number; stopLoss: number;
  takeProfit: number; plannedQuantity: number; pnl: number; grossPnl: number; feesUsdt: number;
  status: "closed" | "open"; exitReason: string | null; entryTime: Date; exitTime: Date | null;
  holdingSeconds: number | null; marketType: string; confidence: number;
  rMultiple: number | null; outcome: "win" | "loss" | "breakeven";
}

/** Build one trade with internally-consistent entry/stop/exit/pnl for an outcome. */
function genTrade(spec: SectionSpec, hoursAgo: number, outcome: Outcome, open = false): GenTrade {
  const sm = pick(spec.syms);
  const strat = pick(spec.strategies);
  const side: "buy" | "sell" = rand() < 0.62 ? "buy" : "sell";
  const dir = side === "buy" ? 1 : -1;
  const entry = sm.price * (1 + (rand() - 0.5) * 0.01);
  const stopDist = entry * sm.stopPct;
  const qty = spec.riskDollars / stopDist; // risk ≈ riskDollars at the stop
  const notional = qty * entry;
  const fees = 2 * spec.costRate * notional;
  const slPrice = entry - stopDist * dir;
  const rr = 1.8 + rand() * 0.9;
  const tpPrice = entry + stopDist * rr * dir;

  const entryTime = new Date(Date.now() - hoursAgo * 3600_000);
  let exitPrice = entry, exitReason: string | null = null, holdingSeconds: number | null = null;
  let grossPnl = 0;

  if (open) {
    return {
      section: spec.section, symbol: sm.symbol, side, strategyId: strat.id, strategyName: strat.name,
      entryPrice: entry, exitPrice: null, quantity: qty, plannedStopLoss: slPrice, stopLoss: slPrice,
      takeProfit: tpPrice, plannedQuantity: qty, pnl: 0, grossPnl: 0, feesUsdt: fees / 2,
      status: "open", exitReason: null, entryTime, exitTime: null, holdingSeconds: null,
      marketType: spec.marketType, confidence: 60 + Math.round(rand() * 30),
      rMultiple: null, outcome: "breakeven",
    };
  }

  if (outcome === "win") {
    exitPrice = tpPrice; exitReason = "take_profit"; holdingSeconds = 1200 + Math.floor(rand() * 5400);
    grossPnl = (exitPrice - entry) * qty * dir;
  } else if (outcome === "loss") {
    exitPrice = slPrice; exitReason = "stop_loss"; holdingSeconds = 120 + Math.floor(rand() * 3000);
    grossPnl = (exitPrice - entry) * qty * dir;
  } else if (outcome === "scratch") {
    exitPrice = entry * (1 + (rand() - 0.5) * 0.0004); exitReason = "break_even";
    holdingSeconds = 900 + Math.floor(rand() * 2400);
    grossPnl = (exitPrice - entry) * qty * dir;
  } else { // timeout
    exitPrice = entry + stopDist * (rand() - 0.4) * dir; exitReason = "timeout";
    holdingSeconds = 5400 + Math.floor(rand() * 3600);
    grossPnl = (exitPrice - entry) * qty * dir;
  }

  const pnl = grossPnl - fees;
  const exitTime = new Date(entryTime.getTime() + (holdingSeconds ?? 0) * 1000);
  const rMultiple = Math.round((pnl / spec.riskDollars) * 100) / 100;
  const netOutcome: "win" | "loss" | "breakeven" =
    exitReason === "break_even" || Math.abs(pnl) < 0.1 * spec.riskDollars ? "breakeven" : pnl > 0 ? "win" : "loss";

  return {
    section: spec.section, symbol: sm.symbol, side, strategyId: strat.id, strategyName: strat.name,
    entryPrice: entry, exitPrice, quantity: qty, plannedStopLoss: slPrice, stopLoss: slPrice,
    takeProfit: tpPrice, plannedQuantity: qty, pnl, grossPnl, feesUsdt: fees,
    status: "closed", exitReason, entryTime, exitTime, holdingSeconds,
    marketType: spec.marketType, confidence: 55 + Math.round(rand() * 35),
    rMultiple, outcome: netOutcome,
  };
}

/** Outcome mix per section — believable, mildly positive after scratches. */
function buildTrades(spec: SectionSpec): GenTrade[] {
  const plan: Array<[Outcome, number]> = [
    ["win", 16], ["loss", 12], ["scratch", 8], ["timeout", 4],
  ];
  const trades: GenTrade[] = [];
  let idx = 0;
  for (const [outcome, count] of plan) {
    for (let i = 0; i < count; i++) {
      // Spread across the last ~10 days, with a cluster inside the last 24h
      // so "today's" KPIs on the hero panel are populated.
      const hoursAgo = idx % 5 === 0 ? rand() * 22 : rand() * 240;
      trades.push(genTrade(spec, hoursAgo, outcome));
      idx++;
    }
  }
  // A couple of open positions per section for the dashboard monitor.
  trades.push(genTrade(spec, rand() * 3, "win", true));
  trades.push(genTrade(spec, rand() * 6, "loss", true));
  return trades.sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());
}

async function wipeDemo(userId: number): Promise<void> {
  const tIds = (await db.select({ id: tradesTable.id }).from(tradesTable).where(eq(tradesTable.userId, userId))).map((r) => r.id);
  if (tIds.length) await db.delete(tradePartialExitsTable).where(inArray(tradePartialExitsTable.tradeId, tIds));
  await db.delete(tradeAnalysesTable).where(eq(tradeAnalysesTable.userId, userId));
  await db.delete(tradesTable).where(eq(tradesTable.userId, userId));
  await db.delete(strategyDecisionsTable).where(eq(strategyDecisionsTable.userId, userId));
  await db.delete(hourlyStatsTable).where(eq(hourlyStatsTable.userId, userId));
  await db.delete(blacklistTable).where(eq(blacklistTable.userId, userId));
  await db.delete(autopsyRunsTable).where(eq(autopsyRunsTable.userId, userId));
  await db.delete(backtestRunsTable).where(eq(backtestRunsTable.userId, userId));
  await db.delete(strategyConfigsTable).where(eq(strategyConfigsTable.userId, userId));
  await db.delete(botConfigTable).where(eq(botConfigTable.userId, userId));
  // Demo holds no exchange creds — clear defensively in case a prior seed added any.
  await db.delete(userBinanceCredentialsTable).where(eq(userBinanceCredentialsTable.userId, userId));
  await db.delete(userOandaCredentialsTable).where(eq(userOandaCredentialsTable.userId, userId));
}

async function seedSection(userId: number, spec: SectionSpec): Promise<void> {
  // bot_config
  await db.insert(botConfigTable).values({
    userId, section: spec.section,
    broker: spec.section === "forex" ? "oanda" : "binance",
    marketType: spec.marketType,
    riskModel: "dollar",
    positionSizeUsdt: spec.section === "forex" ? "5000" : "300",
    maxLossUsdt: String(spec.riskDollars), targetProfitUsdt: String(spec.riskDollars * 2),
    pairs: spec.pairs, testnet: true, engineDesiredRunning: false,
  });

  // trades + analyses + executed decisions
  const trades = buildTrades(spec);
  for (const t of trades) {
    const [row] = await db.insert(tradesTable).values({
      userId, section: t.section, symbol: t.symbol, side: t.side,
      entryPrice: t.entryPrice.toFixed(8), exitPrice: t.exitPrice != null ? t.exitPrice.toFixed(8) : null,
      quantity: t.quantity.toFixed(8), plannedQuantity: t.plannedQuantity.toFixed(8),
      pnl: t.pnl.toFixed(8), grossPnl: t.grossPnl.toFixed(8), feesUsdt: t.feesUsdt.toFixed(8),
      status: t.status, confidence: t.confidence.toFixed(2),
      stopLoss: t.stopLoss.toFixed(8), plannedStopLoss: t.plannedStopLoss.toFixed(8),
      takeProfit: t.takeProfit.toFixed(8), entryTime: t.entryTime, exitTime: t.exitTime,
      exitReason: t.exitReason, strategyId: t.strategyId, strategyName: t.strategyName,
      holdingSeconds: t.holdingSeconds, marketType: t.marketType,
      remainingQuantity: t.quantity.toFixed(8),
      entryReason: `${t.strategyName} signal on ${t.symbol}`,
      isBacktest: false,
    }).returning({ id: tradesTable.id });

    if (t.status === "closed") {
      const grade = t.outcome === "win" ? pick(["A", "B", "B"]) : t.outcome === "breakeven" ? "C" : pick(["C", "D"]);
      await db.insert(tradeAnalysesTable).values({
        userId, tradeId: row!.id, outcome: t.outcome,
        rMultiple: t.rMultiple != null ? t.rMultiple.toFixed(4) : null, grade,
        findings: JSON.stringify([
          `Exit via ${t.exitReason} after ${Math.round((t.holdingSeconds ?? 0) / 60)} min`,
          `Realized ${t.rMultiple}R against planned risk`,
        ]),
        summary: t.outcome === "win"
          ? `Clean ${t.side === "buy" ? "long" : "short"} on ${t.symbol} — target reached for +${t.rMultiple}R.`
          : t.outcome === "breakeven"
            ? `Scratched at break-even on ${t.symbol}; the move stalled after TP1, protected profit taken.`
            : `Stopped on ${t.symbol} at ${t.rMultiple}R — thesis invalidated.`,
      });
      await db.insert(strategyDecisionsTable).values({
        userId, section: t.section, symbol: t.symbol, strategyId: t.strategyId, strategyName: t.strategyName,
        kind: "executed", side: t.side === "buy" ? "long" : "short", confidence: t.confidence.toFixed(2),
        reason: `Entered ${t.symbol} — ${t.strategyName} setup confirmed`, tradeId: row!.id,
        createdAt: t.entryTime, lastSeenAt: t.entryTime,
      });
    }
  }

  // A handful of reasoned REJECTIONS so the Decisions feed shows the "why we passed" side.
  const rejReasons: Array<{ stage: string; reason: string }> = [
    { stage: "reward-risk", reason: "net reward:risk 0.42 below 0.50 floor after costs" },
    { stage: "coin-fit", reason: "target 0.28% unreachable within the hold window at this volatility" },
    { stage: "setup", reason: "breakout already extended 0.9% past the level — chasing a spent move" },
    { stage: "dollar-plan", reason: "nearest resistance 0.12% away — target parked behind it" },
  ];
  for (let i = 0; i < 6; i++) {
    const sm = pick(spec.syms); const strat = pick(spec.strategies); const rej = pick(rejReasons);
    const at = new Date(Date.now() - rand() * 36 * 3600_000);
    await db.insert(strategyDecisionsTable).values({
      userId, section: spec.section, symbol: sm.symbol, strategyId: strat.id, strategyName: strat.name,
      kind: "rejected", side: rand() < 0.5 ? "long" : "short",
      confidence: (40 + rand() * 20).toFixed(2), stage: rej.stage, reason: rej.reason,
      occurrences: 1 + Math.floor(rand() * 8), createdAt: at, lastSeenAt: at,
    });
  }

  // hourly_stats aggregated from the closed trades
  const byHour = new Map<string, { pnl: number; trades: number; wins: number; date: string; hour: number }>();
  for (const t of trades) {
    if (t.status !== "closed" || !t.exitTime) continue;
    const d = t.exitTime;
    const date = d.toISOString().slice(0, 10);
    const hour = d.getUTCHours();
    const key = `${date}:${hour}`;
    const cur = byHour.get(key) ?? { pnl: 0, trades: 0, wins: 0, date, hour };
    cur.pnl += t.pnl; cur.trades++; if (t.pnl > 0) cur.wins++;
    byHour.set(key, cur);
  }
  for (const s of byHour.values()) {
    await db.insert(hourlyStatsTable).values({
      userId, section: spec.section, date: s.date, hour: s.hour,
      pnl: s.pnl.toFixed(8), tradeCount: s.trades, winCount: s.wins,
    }).onConflictDoNothing();
  }
}

async function seedAutopsy(userId: number): Promise<void> {
  const now = Date.now();
  const trainStart = new Date(now - 45 * 86400_000);
  const trainEnd = new Date(now - 15 * 86400_000);
  await db.insert(autopsyRunsTable).values({
    userId, section: "crypto", strategyId: "mean_reversion", strategyName: "Mean Reversion",
    symbols: "BTCUSDT,ETHUSDT,SOLUSDT", timeframe: "5m",
    trainStart, trainEnd, valStart: trainEnd, valEnd: new Date(now),
    status: "completed", progress: 100, totalBacktests: 27,
    currentParams: { maxLossUsdt: 40, targetProfitUsdt: 80, confidenceThreshold: 60, maxHoldingSeconds: 1800 },
    bestParams: { maxLossUsdt: 40, targetProfitUsdt: 64, confidenceThreshold: 66, maxHoldingSeconds: 2700 },
    currentTrain: { totalTrades: 41, winRate: 0.44, profitFactor: 0.96, sharpeRatio: -0.1, maxDrawdown: 0.08, totalPnl: -12 },
    currentVal: { totalTrades: 19, winRate: 0.42, profitFactor: 0.89, sharpeRatio: -0.2, maxDrawdown: 0.06, totalPnl: -18 },
    bestTrain: { totalTrades: 33, winRate: 0.52, profitFactor: 1.28, sharpeRatio: 0.4, maxDrawdown: 0.05, totalPnl: 41 },
    bestVal: { totalTrades: 15, winRate: 0.53, profitFactor: 1.22, sharpeRatio: 0.5, maxDrawdown: 0.04, totalPnl: 28 },
    verdict: "improved",
    diagnosis: {
      summary: "A lower target (0.8× current) and a higher confidence floor beat the live config out-of-sample: fewer, cleaner trades turned a losing profit factor into 1.22 on the held-out window.",
      findings: [
        { param: "targetProfitUsdt", label: "Target Profit", current: 80, suggested: 64, evidence: "The 80 target was unreached in 38% of trades that then timed out; 64 is reached inside the hold window.", action: "Lower Target Profit to ~$64." },
        { param: "confidenceThreshold", label: "Confidence Floor", current: 60, suggested: 66, evidence: "Trades below 66 confidence won 31% vs 54% above it.", action: "Raise the confidence floor to 66." },
      ],
    },
    createdAt: new Date(now - 2 * 86400_000), completedAt: new Date(now - 2 * 86400_000 + 600_000),
  });
}

async function seedBacktests(userId: number): Promise<void> {
  const now = Date.now();
  const mk = (section: string, symbols: string, tf: string, ret: number, wr: number, pf: number, trades: number, days: number) => ({
    userId, section, strategyName: "TradeCore v1", symbols, timeframe: tf,
    startDate: new Date(now - days * 86400_000), endDate: new Date(now),
    startingBalance: "1000.00", endingBalance: (1000 * (1 + ret)).toFixed(2),
    totalReturn: ret.toFixed(4), totalPnl: (1000 * ret).toFixed(2),
    totalTrades: trades, winningTrades: Math.round(trades * wr), losingTrades: trades - Math.round(trades * wr),
    winRate: wr.toFixed(4), profitFactor: pf.toFixed(4), sharpeRatio: "1.12", sortinoRatio: "1.48",
    maxDrawdown: "0.0740", averageWin: "9.20", averageLoss: "-5.60",
    status: "completed", progress: 100, params: { marketType: section === "forex" ? "forex" : "spot" },
    createdAt: new Date(now - 3 * 86400_000),
  });
  await db.insert(backtestRunsTable).values(mk("crypto", "BTCUSDT,ETHUSDT,SOLUSDT", "5m", 0.083, 0.49, 1.34, 128, 90));
  await db.insert(backtestRunsTable).values(mk("forex", "EUR_USD,GBP_USD,XAU_USD", "15m", 0.041, 0.52, 1.21, 74, 60));
}

async function main() {
  // Upsert the demo user (password-less: the ONLY way in is POST /auth/demo).
  let [demo] = await db.select().from(usersTable).where(eq(usersTable.username, DEMO_USERNAME));
  if (!demo) {
    [demo] = await db.insert(usersTable).values({
      username: DEMO_USERNAME, passwordHash: null, isDemo: true,
      displayName: "Demo Account", email: null,
    }).returning();
    console.log(`Created demo user id=${demo!.id}`);
  } else {
    await db.update(usersTable).set({ isDemo: true, displayName: "Demo Account" }).where(eq(usersTable.id, demo.id));
    console.log(`Refreshing existing demo user id=${demo.id}`);
  }
  const userId = demo!.id;

  await wipeDemo(userId);
  await seedSection(userId, CRYPTO);
  await seedSection(userId, FOREX);
  await seedAutopsy(userId);
  await seedBacktests(userId);

  console.log("Demo account seeded: crypto + forex trades, decisions, hourly stats, autopsy, backtests.");
  process.exit(0);
}
main().catch((e) => { console.error("seedDemo failed:", e); process.exit(1); });

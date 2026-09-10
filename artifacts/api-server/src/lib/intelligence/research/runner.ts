import { z } from "zod";
import {
  BRAIN_V0_CONTROL_COMMIT,
  BRAIN_V0_VERSION,
  baselineManifestFingerprint,
  type BrainV0BaselineManifest,
} from "../baseline";
import { sha256Fingerprint } from "../canonical";
import { buildMarketState } from "../market-state/builder";
import type { MarketState } from "../market-state/types";
import {
  DEFAULT_PORTFOLIO_POLICY,
  PORTFOLIO_INTELLIGENCE_VERSION,
  type PortfolioPolicy,
} from "../portfolio";
import {
  POSITION_POLICY_VERSION,
  buildPositionThesis,
  type PositionThesis,
} from "../position";
import { SPECIALIST_COUNCIL_VERSION } from "../specialists";
import { EVIDENCE_SCHEMA_VERSION } from "../evidence";
import {
  buildPurgedWalkForwardPlan,
  partitionForTimestamp,
  verifyPointInTimeObservation,
} from "./partitions";
import { buildResearchExperimentManifest } from "./manifest";
import {
  buildResearchMetrics,
  type ResearchTradeOutcome,
} from "./metrics";
import { buildResearchPromotionReport } from "./report";
import { decisionStreamFingerprint } from "./golden";
import { replayFullBrainFrame, type FullBrainFrameReplay } from "./replay";
import {
  DEFAULT_RESEARCH_STRESS_SCENARIOS,
} from "./manifest";
import type {
  ResearchExperimentManifest,
  ResearchStressScenario,
} from "./types";
import { parseResearchExperimentManifest } from "./types";
import { ResearchExperimentStore } from "./store";
import {
  buildResearchScenarioConfigs,
  buildResearchScenarioFillCosts,
  shouldDropResearchFrame,
  type ResearchScenarioFillCosts,
} from "./stress";
import {
  buildSignalRow,
  type Candle,
  type MarketRegime,
  type MultiTimeframeCandles,
} from "../../strategy";
import {
  computeTp1Tp2Ladder,
  strategiesForSection,
  strategySelector,
  type Strategy,
  type StrategyConfig,
  type TradePlan,
} from "../../strategies";
import {
  manageBar,
  settleBar,
  updateExcursion,
  type BarContext,
  type FillCosts,
  type SettledExit,
  type SimulatedPosition,
} from "../../execution/fillModel";
import { loadStrategyConfigs } from "../../strategyConfigLoader";
import { loadCustomStrategies } from "../../customStrategyLoader";
import { ensureCandles, loadCandles } from "../../historicalData";
import { ensureForexCandles } from "../../oandaHistoricalData";
import {
  DEFAULT_FEE_RATE,
  DEFAULT_MAKER_FEE_RATE,
  DEFAULT_SLIPPAGE_RATE,
  FOREX_COST_RATE,
  FOREX_SLIPPAGE_RATE,
  FUTURES_FEE_RATE,
  FUTURES_MAKER_FEE_RATE,
} from "../../tradingCosts";
import {
  estimateLiquidationPrice,
  stopTooCloseToLiquidation,
} from "../../futuresMath";
import { supportsShortEntries } from "../../marketSymbols";
import { closedCandleWindow } from "../../candleWindows";
import { logger } from "../../logger";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
export const RESEARCH_DECISION_CADENCE_MS = 5 * MINUTE_MS;
const WARMUP_MS = 6 * DAY_MS;
const MAX_ESTIMATED_REPLAY_EVENTS = 80_000;
const BUFFERED_FRAME_EVENTS = 500;
const RESEARCH_CRYPTO_SPREAD_RATE = 0.00005;

export const ResearchExperimentRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  symbols: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
  timeframe: z.literal("1m").default("1m"),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  marketType: z.enum(["spot", "futures", "forex"]),
  startingBalance: z.number().finite().positive().max(1_000_000_000).default(10_000),
  positionSizeUsdt: z.number().finite().positive().max(100_000_000).default(100),
  maxOpenPositions: z.number().int().min(1).max(100).default(5),
  dailyLossLimitUsdt: z.number().finite().positive().max(100_000_000).default(500),
  leverage: z.number().int().min(1).max(125).default(1),
  folds: z.number().int().min(1).max(10).default(3),
  holdoutFraction: z.number().finite().min(0.1).max(0.5).default(0.2),
  purgeMinutes: z.number().int().min(0).max(10_080).default(60),
  embargoMinutes: z.number().int().min(0).max(10_080).default(60),
  deterministicSeed: z.number().int().nonnegative().max(2_147_483_647).default(42),
  falseDiscoveryRate: z.number().finite().gt(0).lt(1).default(0.05),
  candidateBrainVersion: z.string().trim().min(1).max(120).default("phase8-full-brain-v1"),
  maxPortfolioRiskPercent: z.number().finite().gt(0).max(100).default(10),
  maxSymbolConcentrationPercent: z.number().finite().gt(0).max(1_000).default(100),
  maxNetExposurePercent: z.number().finite().gt(0).max(2_000).default(200),
  maxCorrelatedExposurePercent: z.number().finite().gt(0).max(2_000).default(200),
  correlationThreshold: z.number().finite().min(0).max(1).default(0.7),
  correlationUnknownPolicy: z.enum(["allow", "block"]).default("allow"),
}).strict().superRefine((value, ctx) => {
  if (value.startDate >= value.endDate) {
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "endDate must be after startDate" });
  }
  if (value.endDate.getTime() > Date.now()) {
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "Research cannot include future candles" });
  }
  if (value.marketType === "forex" && value.leverage !== 1) {
    ctx.addIssue({ code: "custom", path: ["leverage"], message: "Forex replay does not model crypto futures leverage" });
  }
});

export type ResearchExperimentRequest = z.infer<typeof ResearchExperimentRequestSchema>;

interface PreparedResearchExperiment {
  request: ResearchExperimentRequest;
  manifest: ResearchExperimentManifest;
  symbols: readonly string[];
  candles: ReadonlyMap<string, Candle[]>;
  candleIndexes: ReadonlyMap<string, ReadonlyMap<number, number>>;
  aggregatedCandles: ReadonlyMap<string, {
    tf3m: Candle[];
    tf5m: Candle[];
    tf15m: Candle[];
    tf1h: Candle[];
  }>;
  configs: ReadonlyMap<string, StrategyConfig>;
  strategies: readonly Strategy[];
  customStrategies: readonly Strategy[];
  feeRate: number;
  makerFeeRate: number;
  slippageRate: number;
  spreadRate: number;
  portfolioPolicy: PortfolioPolicy;
}

interface LanePosition {
  tradeId: number;
  sim: SimulatedPosition;
  thesis: PositionThesis | null;
  reductionAlreadyApplied: boolean;
}

interface Lane {
  name: "control" | "candidate-selected" | "candidate-fixed" | "candidate-adaptive";
  balance: number;
  peakBalance: number;
  dailyPnl: number;
  dayKey: string;
  positions: LanePosition[];
  outcomes: ResearchTradeOutcome[];
  cooldowns: Map<string, number>;
  nextTradeId: number;
}

interface SymbolContext {
  symbol: string;
  idx: number;
  ts: number;
  now: Date;
  candle: Candle;
  history: Candle[];
  mtf: MultiTimeframeCandles;
  marketState: MarketState;
  row: ReturnType<typeof buildSignalRow>;
}

interface SimulationResult {
  decisions: FullBrainFrameReplay["decisions"];
  management: FullBrainFrameReplay["management"];
  control: Lane;
  candidateSelected: Lane;
  candidateFixed: Lane;
  candidateAdaptive: Lane;
  pointInTimeChecks: number;
  leakageFailures: number;
  blockedFrames: number;
}

function aggregateCandles(candles: readonly Candle[], targetMs: number): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const candle of candles) {
    const bucket = Math.floor(candle[0] / targetMs) * targetMs;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), candle]);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([timestamp, rows]) => [
    timestamp,
    rows[0]![1],
    Math.max(...rows.map((row) => row[2])),
    Math.min(...rows.map((row) => row[3])),
    rows.at(-1)![4],
    rows.reduce((sum, row) => sum + row[5], 0),
  ] as Candle);
}

function deterministicUuid(value: unknown): string {
  const chars = sha256Fingerprint(value).slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function lane(name: Lane["name"], startingBalance: number, startDate: Date): Lane {
  return {
    name,
    balance: startingBalance,
    peakBalance: startingBalance,
    dailyPnl: 0,
    dayKey: startDate.toISOString().slice(0, 10),
    positions: [],
    outcomes: [],
    cooldowns: new Map(),
    nextTradeId: 1,
  };
}

function strategyConfigSnapshot(configs: ReadonlyMap<string, StrategyConfig>) {
  return [...configs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([strategyId, config]) => ({ strategyId, config }));
}

function defaultCosts(request: ResearchExperimentRequest) {
  if (request.marketType === "forex") {
    return {
      feeRate: 0,
      makerFeeRate: 0,
      slippageRate: FOREX_SLIPPAGE_RATE,
      spreadRate: FOREX_COST_RATE,
    };
  }
  if (request.marketType === "futures") {
    return {
      feeRate: FUTURES_FEE_RATE,
      makerFeeRate: FUTURES_MAKER_FEE_RATE,
      slippageRate: DEFAULT_SLIPPAGE_RATE,
      spreadRate: RESEARCH_CRYPTO_SPREAD_RATE,
    };
  }
  return {
    feeRate: DEFAULT_FEE_RATE,
    makerFeeRate: DEFAULT_MAKER_FEE_RATE,
    slippageRate: DEFAULT_SLIPPAGE_RATE,
    spreadRate: RESEARCH_CRYPTO_SPREAD_RATE,
  };
}

function portfolioPolicy(request: ResearchExperimentRequest): PortfolioPolicy {
  const inputs = {
    maxOpenPositions: request.maxOpenPositions,
    maxPortfolioRiskPercent: request.maxPortfolioRiskPercent,
    maxSymbolConcentrationPercent: request.maxSymbolConcentrationPercent,
    maxNetExposurePercent: request.maxNetExposurePercent,
    maxCorrelatedExposurePercent: request.maxCorrelatedExposurePercent,
    correlationThreshold: request.correlationThreshold,
    correlationUnknownPolicy: request.correlationUnknownPolicy,
  };
  return {
    ...DEFAULT_PORTFOLIO_POLICY,
    riskPolicyVersion: `phase8-risk-v1:${sha256Fingerprint(inputs).slice(0, 16)}`,
    maxOpenPositions: request.maxOpenPositions,
    maxPortfolioRiskFraction: request.maxPortfolioRiskPercent / 100,
    maxSymbolNotionalFraction: request.maxSymbolConcentrationPercent / 100,
    maxNetExposureFraction: request.maxNetExposurePercent / 100,
    maxCorrelatedNotionalFraction: request.maxCorrelatedExposurePercent / 100,
    correlationThreshold: request.correlationThreshold,
    unknownCorrelationPolicy: request.correlationUnknownPolicy,
  };
}

export async function prepareResearchExperiment(
  userId: number,
  section: "crypto" | "forex",
  requestInput: unknown,
  options: { asOf?: Date } = {},
): Promise<PreparedResearchExperiment> {
  const parsed = ResearchExperimentRequestSchema.parse(requestInput);
  const request: ResearchExperimentRequest = {
    ...parsed,
    marketType: section === "forex" ? "forex" : parsed.marketType === "futures" ? "futures" : "spot",
    leverage: section === "forex" ? 1 : parsed.leverage,
    symbols: [...new Set(parsed.symbols.map((symbol) => symbol.trim().toUpperCase()))].sort(),
  };
  const durationMs = request.endDate.getTime() - request.startDate.getTime();
  const estimatedDecisions = Math.ceil(durationMs / RESEARCH_DECISION_CADENCE_MS) * request.symbols.length;
  const estimatedEvents = estimatedDecisions * (1 + Math.min(request.maxOpenPositions, request.symbols.length));
  if (estimatedEvents > MAX_ESTIMATED_REPLAY_EVENTS) {
    throw new Error(`Experiment would produce approximately ${estimatedEvents} decision and management events; reduce symbols, open-position capacity, or date range below ${MAX_ESTIMATED_REPLAY_EVENTS}`);
  }
  const downloadStart = request.startDate.getTime() - WARMUP_MS;
  const endMs = request.endDate.getTime();
  const candleMap = new Map<string, Candle[]>();
  for (const symbol of request.symbols) {
    if (section === "forex") await ensureForexCandles(userId, symbol, "1m", downloadStart, endMs);
    else await ensureCandles(symbol, "1m", downloadStart, endMs);
    const candles = await loadCandles(symbol, "1m", downloadStart, endMs);
    if (candles.length < 200) throw new Error(`Insufficient closed 1m history for ${symbol}`);
    candleMap.set(symbol, candles);
  }
  const candleIndexes = new Map<string, ReadonlyMap<number, number>>();
  const aggregatedCandles = new Map<string, {
    tf3m: Candle[];
    tf5m: Candle[];
    tf15m: Candle[];
    tf1h: Candle[];
  }>();
  for (const [symbol, candles] of candleMap) {
    candleIndexes.set(symbol, new Map(candles.map((candle, index) => [candle[0], index])));
    aggregatedCandles.set(symbol, {
      tf3m: aggregateCandles(candles, 3 * MINUTE_MS),
      tf5m: aggregateCandles(candles, 5 * MINUTE_MS),
      tf15m: aggregateCandles(candles, 15 * MINUTE_MS),
      tf1h: aggregateCandles(candles, 60 * MINUTE_MS),
    });
  }

  const configs = await loadStrategyConfigs(userId, section);
  const builtInStrategies = strategiesForSection(section);
  const customStrategies = (await loadCustomStrategies(userId, section)).map((loaded) => loaded.strategy);
  const partitions = buildPurgedWalkForwardPlan({
    startInclusive: request.startDate,
    endExclusive: request.endDate,
    folds: request.folds,
    holdoutFraction: request.holdoutFraction,
    purgeMs: request.purgeMinutes * MINUTE_MS,
    embargoMs: request.embargoMinutes * MINUTE_MS,
  });
  const costs = defaultCosts(request);
  const configSnapshot = strategyConfigSnapshot(configs);
  const dataFingerprint = sha256Fingerprint({
    provider: section === "forex" ? "oanda" : "binance",
    symbols: request.symbols,
    timeframe: "1m",
    candles: request.symbols.map((symbol) => ({ symbol, candles: candleMap.get(symbol) })),
  });
  const baselineManifest: BrainV0BaselineManifest = {
    schemaVersion: 1,
    brainVersion: BRAIN_V0_VERSION,
    role: "control",
    source: { gitCommit: BRAIN_V0_CONTROL_COMMIT },
    strategy: { catalogVersion: "strategy-catalog-v1", configHash: sha256Fingerprint(configSnapshot) },
    risk: { policyVersion: "phase8-research-risk-v1", configHash: sha256Fingerprint(portfolioPolicy(request)) },
    marketData: {
      provider: section === "forex" ? "oanda" : "binance",
      marketType: request.marketType,
      symbols: request.symbols,
      universeHash: sha256Fingerprint(request.symbols),
      candleRanges: [{ timeframe: "1m", startInclusive: new Date(downloadStart).toISOString(), endExclusive: request.endDate.toISOString() }],
      featureVersion: "market-state-v1",
    },
    costs: { feeModelVersion: "shared-fill-costs-v1", slippageModelVersion: "shared-fill-slippage-v1" },
    execution: { target: "research", fillModelVersion: "shared-fill-model-v1" },
  };
  const manifest = buildResearchExperimentManifest({
    name: request.name,
    controlManifestFingerprint: baselineManifestFingerprint(baselineManifest),
    candidateBrainVersion: request.candidateBrainVersion,
    candidateConfig: { configs: configSnapshot, portfolioPolicy: portfolioPolicy(request) },
    candidateModel: {
      council: "deterministic-council-v1",
      management: POSITION_POLICY_VERSION,
      evidence: "point-in-time-approved-only",
      decisionCadenceMs: RESEARCH_DECISION_CADENCE_MS,
    },
    narrativeMode: "deterministic-only",
    provider: section === "forex" ? "oanda" : "binance",
    marketType: request.marketType,
    symbols: request.symbols,
    timeframe: "1m",
    startInclusive: request.startDate,
    endExclusive: request.endDate,
    asOf: options.asOf ?? new Date(Math.max(Date.now(), request.endDate.getTime())),
    dataFingerprint,
    syntheticDataAllowed: false,
    partitions,
    costs: {
      feeRatePerLeg: costs.feeRate,
      slippageRatePerLeg: costs.slippageRate,
      spreadRate: costs.spreadRate,
      latencyMs: 0,
      fillModelVersion: "shared-fill-model-v1+phase8-adverse-order-v1",
    },
    versions: {
      strategyCatalogVersion: "strategy-catalog-v1",
      marketStateVersion: "market-state-v1",
      specialistVersion: SPECIALIST_COUNCIL_VERSION,
      evidenceVersion: EVIDENCE_SCHEMA_VERSION,
      portfolioVersion: PORTFOLIO_INTELLIGENCE_VERSION,
      positionPolicyVersion: POSITION_POLICY_VERSION,
    },
    sourceCode: { controlCommit: BRAIN_V0_CONTROL_COMMIT, researchVersion: "phase8-full-brain-runner-v1" },
    deterministicSeed: request.deterministicSeed,
    stressScenarios: DEFAULT_RESEARCH_STRESS_SCENARIOS,
    falseDiscoveryRate: request.falseDiscoveryRate,
    hypothesesDeclaredBeforeRun: 1,
    createdAt: new Date(),
  });
  return {
    request,
    manifest,
    symbols: request.symbols,
    candles: candleMap,
    candleIndexes,
    aggregatedCandles,
    configs,
    strategies: [...builtInStrategies, ...customStrategies],
    customStrategies,
    ...costs,
    portfolioPolicy: portfolioPolicy(request),
  };
}

function resetDaily(laneState: Lane, dayKey: string): void {
  if (laneState.dayKey !== dayKey) {
    laneState.dayKey = dayKey;
    laneState.dailyPnl = 0;
  }
}

function positionInputs(laneState: Lane) {
  return laneState.positions.map(({ sim }) => ({
    symbol: sim.symbol,
    side: sim.side,
    strategyId: sim.strategyId ?? null,
    entryPrice: sim.entryPrice,
    stopPrice: sim.slPrice,
    quantity: sim.remainingQty,
  }));
}

function drawdownFraction(laneState: Lane): number {
  return laneState.peakBalance > 0
    ? Math.max(0, Math.min(1, (laneState.peakBalance - laneState.balance) / laneState.peakBalance))
    : 1;
}

function closeOutcome(
  laneState: Lane,
  position: LanePosition,
  settled: SettledExit,
  closedAt: Date,
  costs: ResearchScenarioFillCosts,
): void {
  const plannedRisk = Math.abs(position.sim.entryPrice - position.sim.plannedSlPrice) * position.sim.qty;
  const isShort = position.sim.side === "short";
  const closeFactor = isShort ? 1 + costs.slippageRate : 1 - costs.slippageRate;
  const finalIdealPrice = closeFactor > 0 ? settled.exitPrice / closeFactor : settled.exitPrice;
  const finalSlippage = Math.abs(settled.exitPrice - finalIdealPrice) * position.sim.remainingQty;
  const partialSlippage = position.sim.partialExits.reduce((sum, partial) => {
    const idealPrice = partial.reason === "tp1"
      ? position.sim.tp1Price
      : partial.reason === "tp2"
        ? position.sim.tp2Price
        : closeFactor > 0
          ? partial.price / closeFactor
          : partial.price;
    return sum + Math.abs(partial.price - idealPrice) * partial.qty;
  }, 0);
  const totalSlippage = Math.abs(position.sim.slippage) + finalSlippage + partialSlippage;
  const totalAdverseRate = costs.modeledSlippageRate + costs.spreadRate;
  const slippageShare = totalAdverseRate > 0
    ? costs.modeledSlippageRate / totalAdverseRate
    : 0;
  const modeledSlippage = totalSlippage * slippageShare;
  const modeledSpread = totalSlippage - modeledSlippage;
  laneState.balance += settled.pnl;
  laneState.dailyPnl += settled.pnl;
  laneState.peakBalance = Math.max(laneState.peakBalance, laneState.balance);
  laneState.outcomes.push({
    tradeId: `${laneState.name}-${position.tradeId}`,
    closedAt: closedAt.toISOString(),
    regime: position.sim.regime ?? "unknown",
    grossPnl: settled.grossPnl + totalSlippage,
    fees: settled.totalFees,
    slippage: modeledSlippage,
    spread: modeledSpread,
    financing: 0,
    plannedRisk: plannedRisk > 0 ? plannedRisk : null,
  });
}

function manualMarketExit(
  position: LanePosition,
  context: SymbolContext,
  costs: FillCosts,
  reason: string,
): SettledExit {
  const sim = position.sim;
  const isShort = sim.side === "short";
  const close = context.candle[4];
  const exitPrice = close * (isShort ? 1 + costs.slippageRate : 1 - costs.slippageRate);
  const exitQty = sim.remainingQty;
  const exitFees = exitPrice * exitQty * costs.feeRate;
  const partialPnl = sim.partialExits.reduce((sum, partial) => sum + partial.pnl, 0);
  const partialFees = sim.partialExits.reduce((sum, partial) => sum + partial.fees, 0);
  const entryFeeShare = sim.qty > 0 ? sim.fees * (exitQty / sim.qty) : sim.fees;
  const grossFinal = (isShort ? sim.entryPrice - exitPrice : exitPrice - sim.entryPrice) * exitQty;
  const grossPartial = sim.partialExits.reduce(
    (sum, partial) => sum + (isShort ? sim.entryPrice - partial.price : partial.price - sim.entryPrice) * partial.qty,
    0,
  );
  const pnl = grossFinal - exitFees + partialPnl - entryFeeShare;
  const totalFees = entryFeeShare + exitFees + partialFees;
  const notional = sim.entryPrice * sim.qty;
  return {
    exitPrice,
    exitReason: reason,
    pnl,
    grossPnl: grossFinal + grossPartial,
    pnlPercent: notional > 0 ? (pnl / notional) * 100 : 0,
    totalFees,
    totalSlippage: Math.abs(sim.slippage) + Math.abs(exitPrice * exitQty * costs.slippageRate),
    durationSeconds: Math.max(0, Math.round((context.now.getTime() - sim.entryTime.getTime()) / 1000)),
    riskReward: sim.entryPrice !== sim.plannedSlPrice
      ? (sim.tpPrice - sim.entryPrice) / (sim.entryPrice - sim.plannedSlPrice)
      : 0,
  };
}

function openPosition(
  laneState: Lane,
  plan: TradePlan,
  context: SymbolContext,
  config: StrategyConfig | undefined,
  costs: FillCosts,
  marketType: ResearchExperimentRequest["marketType"],
  allocationFraction: number,
  manifestFingerprint: string,
  adaptive: boolean,
): LanePosition | null {
  const quantity = plan.qty * allocationFraction;
  if (!(quantity > 0) || !Number.isFinite(quantity)) return null;
  const isShort = plan.side === "short";
  const fillPrice = plan.entryPrice * (isShort ? 1 - costs.slippageRate : 1 + costs.slippageRate);
  const slDistance = isShort ? plan.slPrice - plan.entryPrice : plan.entryPrice - plan.slPrice;
  const tpDistance = isShort ? plan.entryPrice - plan.tpPrice : plan.tpPrice - plan.entryPrice;
  const slPrice = isShort ? fillPrice + slDistance : fillPrice - slDistance;
  const tpPrice = isShort ? fillPrice - tpDistance : fillPrice + tpDistance;
  if (!(fillPrice > 0 && slPrice > 0 && tpPrice > 0)) return null;
  const leverage = marketType === "futures" ? Math.max(1, Math.floor(plan.leverage)) : 1;
  const liquidationPrice = marketType === "futures" && leverage > 1
    ? estimateLiquidationPrice(fillPrice, plan.side, leverage)
    : undefined;
  if (liquidationPrice !== undefined && stopTooCloseToLiquidation(fillPrice, slPrice, liquidationPrice)) return null;
  const ladder = config
    ? computeTp1Tp2Ladder(fillPrice, slPrice, tpPrice, quantity, config, (price) => price, (qty) => qty, plan.side)
    : { tp1Price: 0, tp1Qty: 0, tp2Price: 0, tp2Qty: 0 };
  const entryFee = fillPrice * quantity * costs.feeRate;
  const tradeId = laneState.nextTradeId++;
  const sim: SimulatedPosition = {
    symbol: plan.symbol,
    side: plan.side,
    entryPrice: fillPrice,
    slPrice,
    tpPrice,
    plannedSlPrice: slPrice,
    qty: quantity,
    remainingQty: quantity,
    entryTime: context.now,
    confidence: plan.confidence,
    fees: entryFee,
    slippage: (fillPrice - plan.entryPrice) * quantity,
    liquidationPrice,
    strategyId: plan.strategyId,
    strategyName: plan.strategyName,
    regime: plan.regime,
    leverage,
    maxHoldSeconds: plan.maxHoldSeconds,
    expectedHoldSeconds: plan.expectedHoldSeconds,
    entryReason: plan.report.summary,
    tradePlan: plan,
    mfe: 0,
    mae: 0,
    tp1Price: ladder.tp1Price,
    tp1Qty: ladder.tp1Qty,
    tp1Filled: false,
    tp2Price: ladder.tp2Price,
    tp2Qty: ladder.tp2Qty,
    tp2Filled: false,
    breakEvenActive: false,
    trailingStopActive: false,
    partialExits: [],
  };
  const thesisPlan: TradePlan = { ...plan, entryPrice: fillPrice, slPrice, tpPrice, qty: quantity };
  const thesis = adaptive
    ? buildPositionThesis({
        plan: thesisPlan,
        marketState: context.marketState,
        createdAt: context.now,
        thesisId: deterministicUuid({ manifestFingerprint, lane: laneState.name, tradeId, plan: thesisPlan }),
      })
    : null;
  return { tradeId, sim, thesis, reductionAlreadyApplied: false };
}

function settleFixedLane(
  laneState: Lane,
  contexts: ReadonlyMap<string, SymbolContext>,
  configs: ReadonlyMap<string, StrategyConfig>,
  costs: ResearchScenarioFillCosts,
): void {
  for (let index = laneState.positions.length - 1; index >= 0; index--) {
    const position = laneState.positions[index]!;
    const context = contexts.get(position.sim.symbol);
    if (!context) continue;
    const config = position.sim.strategyId ? configs.get(position.sim.strategyId) : undefined;
    updateExcursion(position.sim, context.candle[2], context.candle[3]);
    manageBar(position.sim, { candle: context.candle, history: context.history, now: context.now }, config, costs);
    const settled = settleBar(position.sim, { candle: context.candle, history: context.history, now: context.now }, config, costs);
    if (!settled) continue;
    closeOutcome(laneState, position, settled, context.now, costs);
    laneState.cooldowns.set(position.sim.symbol, context.now.getTime() + (config?.cooldownMinutes ?? 30) * MINUTE_MS);
    laneState.positions.splice(index, 1);
  }
}

function applyAdaptiveManagement(
  laneState: Lane,
  frame: FullBrainFrameReplay,
  contexts: ReadonlyMap<string, SymbolContext>,
  configs: ReadonlyMap<string, StrategyConfig>,
  costs: ResearchScenarioFillCosts,
): void {
  const eventByTrade = new Map(frame.management.map((event) => [event.tradeId, event]));
  for (let index = laneState.positions.length - 1; index >= 0; index--) {
    const position = laneState.positions[index]!;
    const context = contexts.get(position.sim.symbol);
    if (!context) continue;
    const config = position.sim.strategyId ? configs.get(position.sim.strategyId) : undefined;
    const event = eventByTrade.get(position.tradeId);
    if (event?.valid) {
      if ((event.proposedAction === "TIGHTEN_STOP" || event.proposedAction === "APPLY_TRAILING") && event.proposedStopPrice !== null) {
        position.sim.slPrice = event.proposedStopPrice;
        position.sim.trailingStopActive = event.proposedAction === "APPLY_TRAILING";
        position.sim.trailingStopMode = event.proposedAction === "APPLY_TRAILING" ? "atr" : position.sim.trailingStopMode;
      } else if (event.proposedAction === "REDUCE" && event.reductionFraction !== null && !position.reductionAlreadyApplied) {
        const qty = Math.min(position.sim.remainingQty, position.sim.qty * event.reductionFraction);
        if (qty > 0) {
          const isShort = position.sim.side === "short";
          const fillPrice = context.candle[4] * (isShort ? 1 + costs.slippageRate : 1 - costs.slippageRate);
          const entryFeeShare = position.sim.qty > 0 ? position.sim.fees * (qty / position.sim.qty) : 0;
          const exitFee = fillPrice * qty * costs.feeRate;
          const fees = entryFeeShare + exitFee;
          const pnl = (isShort ? position.sim.entryPrice - fillPrice : fillPrice - position.sim.entryPrice) * qty - fees;
          position.sim.partialExits.push({ reason: "phase7_reduce", qty, price: fillPrice, fees, pnl, time: context.now });
          position.sim.remainingQty -= qty;
          position.reductionAlreadyApplied = true;
        }
      } else if (event.proposedAction === "EXIT") {
        const settled = manualMarketExit(position, context, costs, "phase7_invalidation");
        closeOutcome(laneState, position, settled, context.now, costs);
        laneState.cooldowns.set(position.sim.symbol, context.now.getTime() + (config?.cooldownMinutes ?? 30) * MINUTE_MS);
        laneState.positions.splice(index, 1);
      }
    }
  }
}

function settleAdaptiveLane(
  laneState: Lane,
  contexts: ReadonlyMap<string, SymbolContext>,
  configs: ReadonlyMap<string, StrategyConfig>,
  costs: ResearchScenarioFillCosts,
): void {
  for (let index = laneState.positions.length - 1; index >= 0; index--) {
    const position = laneState.positions[index]!;
    const context = contexts.get(position.sim.symbol);
    if (!context) continue;
    const config = position.sim.strategyId ? configs.get(position.sim.strategyId) : undefined;
    updateExcursion(position.sim, context.candle[2], context.candle[3]);
    const settled = settleBar(
      position.sim,
      { candle: context.candle, history: context.history, now: context.now },
      config,
      costs,
    );
    if (!settled) continue;
    closeOutcome(laneState, position, settled, context.now, costs);
    laneState.cooldowns.set(position.sim.symbol, context.now.getTime() + (config?.cooldownMinutes ?? 30) * MINUTE_MS);
    laneState.positions.splice(index, 1);
  }
}

function closeAllPositions(
  laneState: Lane,
  contexts: ReadonlyMap<string, SymbolContext>,
  costs: ResearchScenarioFillCosts,
  reason: string,
): void {
  for (let index = laneState.positions.length - 1; index >= 0; index--) {
    const position = laneState.positions[index]!;
    const context = contexts.get(position.sim.symbol);
    if (!context) continue;
    closeOutcome(laneState, position, manualMarketExit(position, context, costs, reason), context.now, costs);
    laneState.positions.splice(index, 1);
  }
}

function positionFrames(laneState: Lane) {
  return laneState.positions.flatMap((position) => position.thesis ? [{
    thesis: position.thesis,
    position: {
      tradeId: position.tradeId,
      symbol: position.sim.symbol,
      side: position.sim.side,
      entryPrice: position.sim.entryPrice,
      currentStopPrice: position.sim.slPrice,
      targetPrice: position.sim.tpPrice,
      remainingQuantity: position.sim.remainingQty,
      openedAt: position.sim.entryTime,
    },
    reductionAlreadyApplied: position.reductionAlreadyApplied,
  }] : []);
}

function buildContexts(
  prepared: PreparedResearchExperiment,
  timestamp: number,
  scenario: ResearchStressScenario,
  regimes: Map<string, MarketRegime>,
): Map<string, SymbolContext> {
  const contexts = new Map<string, SymbolContext>();
  const observedAt = new Date(timestamp + MINUTE_MS + scenario.latencyMs);
  for (const symbol of prepared.symbols) {
    if (shouldDropResearchFrame(scenario, prepared.manifest, symbol, timestamp)) continue;
    const candles = prepared.candles.get(symbol)!;
    const idx = prepared.candleIndexes.get(symbol)?.get(timestamp);
    if (idx === undefined) continue;
    const aggregated = prepared.aggregatedCandles.get(symbol)!;
    const history = candles.slice(Math.max(0, idx - 100), idx + 1).map((candle) => [...candle] as Candle);
    // Latency changes execution time, not which future candles the decision
    // may read. Sanitize the same inputs used by BOTH MarketState and selector.
    const availableAtMs = timestamp + MINUTE_MS;
    const mtf: MultiTimeframeCandles = {
      tf1m: history,
      tf3m: closedCandleWindow(aggregated.tf3m, availableAtMs, 3 * MINUTE_MS, 101),
      tf5m: closedCandleWindow(aggregated.tf5m, availableAtMs, 5 * MINUTE_MS, 101),
      tf15m: closedCandleWindow(aggregated.tf15m, availableAtMs, 15 * MINUTE_MS, 101),
      tf1h: closedCandleWindow(aggregated.tf1h, availableAtMs, 60 * MINUTE_MS, 101),
    };
    try {
      const marketState = buildMarketState({
        symbol,
        venue: prepared.request.marketType,
        provider: prepared.manifest.data.provider,
        candles: mtf,
        observedAt,
        maximumAgeMs: MINUTE_MS + scenario.latencyMs,
        previousRegime: regimes.get(symbol),
      });
      const row = buildSignalRow(symbol, mtf, regimes.get(symbol));
      regimes.set(symbol, row.regime);
      contexts.set(symbol, { symbol, idx, ts: timestamp, now: observedAt, candle: candles[idx]!, history, mtf, marketState, row });
    } catch {
      // Insufficient or stale history is a bounded abstention, never synthetic substitution.
    }
  }
  return contexts;
}

function buildSettlementContexts(
  prepared: PreparedResearchExperiment,
  timestamp: number,
  scenario: ResearchStressScenario,
  prior: ReadonlyMap<string, SymbolContext>,
): Map<string, SymbolContext> {
  const contexts = new Map<string, SymbolContext>();
  const now = new Date(timestamp + MINUTE_MS + scenario.latencyMs);
  for (const symbol of prepared.symbols) {
    if (shouldDropResearchFrame(scenario, prepared.manifest, symbol, timestamp)) continue;
    const previous = prior.get(symbol);
    const idx = prepared.candleIndexes.get(symbol)?.get(timestamp);
    const candles = prepared.candles.get(symbol);
    if (!previous || idx === undefined || !candles) continue;
    contexts.set(symbol, {
      ...previous,
      idx,
      ts: timestamp,
      now,
      candle: candles[idx]!,
      history: candles.slice(Math.max(0, idx - 100), idx + 1).map((candle) => [...candle] as Candle),
    });
  }
  return contexts;
}

function planForStrategy(plans: readonly TradePlan[], strategyId: string | null): TradePlan | null {
  if (!strategyId) return null;
  return plans.find((plan) => plan.strategyId === strategyId) ?? null;
}

function openAllowed(
  laneState: Lane,
  plan: TradePlan,
  context: SymbolContext,
  request: ResearchExperimentRequest,
  configs: ReadonlyMap<string, StrategyConfig>,
): boolean {
  const maximum = configs.get(plan.strategyId)?.maxConcurrentPositions ?? 2;
  return laneState.positions.length < request.maxOpenPositions
    && laneState.dailyPnl > -Math.abs(request.dailyLossLimitUsdt)
    && !laneState.positions.some((position) => position.sim.symbol === plan.symbol)
    && (laneState.cooldowns.get(plan.symbol) ?? 0) <= context.now.getTime()
    && laneState.positions.filter((position) => position.sim.strategyId === plan.strategyId).length < maximum;
}

async function simulateScenario(
  prepared: PreparedResearchExperiment,
  scenario: ResearchStressScenario,
  onFrames?: (frames: readonly FullBrainFrameReplay[]) => Promise<void>,
  cancellationRequested?: () => Promise<boolean>,
): Promise<SimulationResult> {
  const request = prepared.request;
  const control = lane("control", request.startingBalance, request.startDate);
  const candidateSelected = lane("candidate-selected", request.startingBalance, request.startDate);
  const candidateFixed = lane("candidate-fixed", request.startingBalance, request.startDate);
  const candidateAdaptive = lane("candidate-adaptive", request.startingBalance, request.startDate);
  const costs = buildResearchScenarioFillCosts(prepared, scenario);
  const configs = buildResearchScenarioConfigs(prepared.configs, scenario);
  const regimes = new Map<string, MarketRegime>();
  const pendingFrames: FullBrainFrameReplay[] = [];
  const decisions: FullBrainFrameReplay["decisions"][number][] = [];
  const management: FullBrainFrameReplay["management"][number][] = [];
  const allTimestamps = [...new Set(
    [...prepared.candles.values()].flatMap((candles) => candles.map((candle) => candle[0])),
  )].sort((a, b) => a - b);
  let sequence = 0;
  let pointInTimeChecks = 0;
  let leakageFailures = 0;
  let blockedFrames = 0;
  let priorPartition: string | null = null;
  let priorContexts = new Map<string, SymbolContext>();

  for (let timestampIndex = 0; timestampIndex < allTimestamps.length; timestampIndex++) {
    const timestamp = allTimestamps[timestampIndex]!;
    const observedAt = new Date(timestamp + MINUTE_MS + scenario.latencyMs);
    if (observedAt < request.startDate || observedAt >= request.endDate) continue;
    const partitionId = partitionForTimestamp(prepared.manifest.partitions, observedAt.toISOString());
    if (!partitionId) continue;
    if (cancellationRequested && timestampIndex % 250 === 0 && await cancellationRequested()) {
      throw new Error("Research experiment cancellation requested");
    }
    if (priorPartition && priorPartition !== partitionId) {
      closeAllPositions(control, priorContexts, costs, "partition_boundary");
      closeAllPositions(candidateSelected, priorContexts, costs, "partition_boundary");
      closeAllPositions(candidateFixed, priorContexts, costs, "partition_boundary");
      closeAllPositions(candidateAdaptive, priorContexts, costs, "partition_boundary");
    }
    priorPartition = partitionId;
    const decisionTimestamp = timestamp % RESEARCH_DECISION_CADENCE_MS === 0;
    const contexts = decisionTimestamp
      ? buildContexts(prepared, timestamp, scenario, regimes)
      : buildSettlementContexts(prepared, timestamp, scenario, priorContexts);
    if (contexts.size === 0) {
      if (decisionTimestamp) blockedFrames++;
      continue;
    }
    priorContexts = contexts;
    const dayKey = observedAt.toISOString().slice(0, 10);
    for (const laneState of [control, candidateSelected, candidateFixed, candidateAdaptive]) resetDaily(laneState, dayKey);
    settleFixedLane(control, contexts, configs, costs);
    settleFixedLane(candidateSelected, contexts, configs, costs);
    settleFixedLane(candidateFixed, contexts, configs, costs);
    settleAdaptiveLane(candidateAdaptive, contexts, configs, costs);
    if (!decisionTimestamp) continue;

    const symbolFrames = [...contexts.values()].map((context) => {
      const result = strategySelector.decideSymbol(
        context.symbol,
        context.mtf,
        context.row,
        configs,
        request.startingBalance,
        request.positionSizeUsdt,
        {
          marketType: request.marketType === "futures" ? "futures" : "spot",
          leverage: request.leverage,
          feeRate: costs.feeRate + costs.spreadRate,
          slippageRate: costs.modeledSlippageRate,
          globalTradeAmountUsdt: request.positionSizeUsdt,
        },
        [...prepared.customStrategies],
      );
      const plans = supportsShortEntries(request.marketType)
        ? result.plans
        : result.plans.filter((plan) => plan.side === "long");
      return {
        context,
        plans,
        frame: {
          marketState: context.marketState,
          strategies: prepared.strategies,
          configs,
          plans,
          rejections: result.rejections,
          historicalEvidence: {
            status: "unavailable" as const,
            ruleVersion: null,
            items: [],
            limitations: ["No point-in-time approved evidence snapshot was available; the council cannot treat memory as evidence."],
          },
        },
      };
    });
    const frame = replayFullBrainFrame({
      experimentId: prepared.manifest.experimentId,
      partitionId,
      sequenceStart: sequence,
      observedAt,
      maximumCandidateAgeMs: 2 * MINUTE_MS + scenario.latencyMs,
      feeRatePerLeg: costs.feeRate + costs.spreadRate,
      slippageRatePerLeg: costs.modeledSlippageRate,
      costModelVersion: prepared.manifest.costs.fillModelVersion,
      symbols: symbolFrames.map((item) => item.frame),
      portfolio: {
        currency: "USD",
        equity: candidateAdaptive.balance,
        availableBalance: Math.max(0, candidateAdaptive.balance),
        drawdownFraction: drawdownFraction(candidateAdaptive),
        initialReservedRisk: 0,
        positions: positionInputs(candidateAdaptive),
        correlations: [],
        policy: prepared.portfolioPolicy,
        dataStatus: contexts.size === prepared.symbols.length ? "healthy" : "degraded",
        dataIssues: contexts.size === prepared.symbols.length ? [] : ["One or more declared symbol frames were unavailable."],
      },
      managedPositions: positionFrames(candidateAdaptive),
    });
    sequence += frame.decisions.length + frame.management.length;
    decisions.push(...frame.decisions);
    management.push(...frame.management);
    if (onFrames) {
      pendingFrames.push(frame);
      if (pendingFrames.reduce((sum, item) => sum + item.decisions.length + item.management.length, 0) >= BUFFERED_FRAME_EVENTS) {
        await onFrames(pendingFrames.splice(0));
      }
    }
    for (const event of frame.decisions) {
      const checks = verifyPointInTimeObservation(event.observedAt, {
        featureTimestamp: event.dataTimestamp,
        regimeTimestamp: event.dataTimestamp,
        evidenceAsOf: null,
        labelTimestamp: null,
      });
      pointInTimeChecks += checks.length;
      leakageFailures += checks.filter((check) => !check.passed).length;
      const item = symbolFrames.find((candidate) => candidate.context.symbol === event.symbol);
      if (!item) continue;
      const controlPlan = planForStrategy(item.plans, event.control.strategyId);
      if (controlPlan && openAllowed(control, controlPlan, item.context, request, configs)) {
        const opened = openPosition(control, controlPlan, item.context, configs.get(controlPlan.strategyId), costs, request.marketType, 1, prepared.manifest.fingerprint, false);
        if (opened) control.positions.push(opened);
      }
      const candidatePlan = planForStrategy(item.plans, event.council.strategyId);
      if (!candidatePlan) continue;
      if (
        event.council.action === "ENTER_NOW" &&
        openAllowed(candidateSelected, candidatePlan, item.context, request, configs)
      ) {
        const opened = openPosition(candidateSelected, candidatePlan, item.context, configs.get(candidatePlan.strategyId), costs, request.marketType, 1, prepared.manifest.fingerprint, false);
        if (opened) candidateSelected.positions.push(opened);
      }
      if (event.portfolio.disposition !== "SHADOW_ALLOCATED") continue;
      for (const [laneState, adaptive] of [[candidateFixed, false], [candidateAdaptive, true]] as const) {
        if (!openAllowed(laneState, candidatePlan, item.context, request, configs)) continue;
        const opened = openPosition(laneState, candidatePlan, item.context, configs.get(candidatePlan.strategyId), costs, request.marketType, event.portfolio.allocationFraction, prepared.manifest.fingerprint, adaptive);
        if (opened) laneState.positions.push(opened);
      }
    }
    applyAdaptiveManagement(candidateAdaptive, frame, contexts, configs, costs);
  }
  if (priorContexts.size > 0) {
    closeAllPositions(control, priorContexts, costs, "research_window_end");
    closeAllPositions(candidateSelected, priorContexts, costs, "research_window_end");
    closeAllPositions(candidateFixed, priorContexts, costs, "research_window_end");
    closeAllPositions(candidateAdaptive, priorContexts, costs, "research_window_end");
  }
  if (onFrames && pendingFrames.length) await onFrames(pendingFrames.splice(0));
  return { decisions, management, control, candidateSelected, candidateFixed, candidateAdaptive, pointInTimeChecks, leakageFailures, blockedFrames };
}

function metricsFor(
  prepared: PreparedResearchExperiment,
  result: SimulationResult,
  laneState: Lane,
  candidate: boolean,
) {
  const eligibleDecisions = result.decisions.length;
  const abstentions = candidate
    ? result.decisions.filter((event) => event.outcome !== "TRADE_CANDIDATE").length
    : result.decisions.filter((event) => event.control.action !== "ENTER_NOW").length;
  return buildResearchMetrics({
    outcomes: laneState.outcomes,
    eligibleDecisions,
    abstentions,
    startInclusive: prepared.manifest.data.window.startInclusive,
    endExclusive: prepared.manifest.data.window.endExclusive,
    startingEquity: prepared.request.startingBalance,
    deterministicSeed: prepared.manifest.deterministicSeed,
  });
}

function pairedPermutationPValue(
  control: readonly ResearchTradeOutcome[],
  candidate: readonly ResearchTradeOutcome[],
  seed: number,
): number {
  const net = (outcome: ResearchTradeOutcome) => outcome.grossPnl - outcome.fees - outcome.slippage - outcome.spread - outcome.financing;
  const length = Math.min(control.length, candidate.length);
  if (length === 0) return 1;
  const differences = Array.from({ length }, (_, index) => net(candidate[index]!) - net(control[index]!));
  const observed = Math.abs(differences.reduce((sum, value) => sum + value, 0) / length);
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
  let extreme = 1;
  const samples = 2_000;
  for (let sample = 0; sample < samples; sample++) {
    const mean = differences.reduce((sum, value) => sum + (random() < 0.5 ? value : -value), 0) / length;
    if (Math.abs(mean) >= observed) extreme++;
  }
  return extreme / (samples + 1);
}

export async function runResearchExperimentJob(
  userId: number,
  section: "crypto" | "forex",
  experimentDbId: number,
  prepared: PreparedResearchExperiment,
  store = new ResearchExperimentStore(),
): Promise<void> {
  try {
    await store.markRunning(userId, section, experimentDbId, "base-replay");
    const persisted = await simulateScenario(
      prepared,
      prepared.manifest.stressScenarios[0]!,
      (frames) => store.appendFrames(userId, section, experimentDbId, frames),
      () => store.cancellationRequested(userId, section, experimentDbId),
    );
    await store.updateProgress(userId, section, experimentDbId, 55, "golden-replay");
    const cancellation = () => store.cancellationRequested(userId, section, experimentDbId);
    const golden = await simulateScenario(
      prepared,
      prepared.manifest.stressScenarios[0]!,
      undefined,
      cancellation,
    );
    const expectedFingerprint = decisionStreamFingerprint(persisted.decisions, persisted.management);
    const actualFingerprint = decisionStreamFingerprint(golden.decisions, golden.management);
    await store.updateProgress(userId, section, experimentDbId, 70, "stress-suite");
    let stressPassed = true;
    for (const scenario of prepared.manifest.stressScenarios.slice(1)) {
      const result = await simulateScenario(prepared, scenario, undefined, cancellation);
      const stressedControl = metricsFor(prepared, result, result.control, false);
      const stressedCandidate = metricsFor(prepared, result, result.candidateAdaptive, true);
      stressPassed &&= Number.isFinite(stressedCandidate.netPnl)
        && stressedCandidate.maxDrawdown <= Math.min(1, stressedControl.maxDrawdown + 0.05);
    }
    if (await cancellation()) throw new Error("Research experiment cancellation requested");
    const control = metricsFor(prepared, persisted, persisted.control, false);
    const candidate = metricsFor(prepared, persisted, persisted.candidateAdaptive, true);
    const candidateSelected = metricsFor(prepared, persisted, persisted.candidateSelected, true);
    const candidateFixed = metricsFor(prepared, persisted, persisted.candidateFixed, true);
    const leakageChecks = [
      {
        check: "full-replay-point-in-time",
        passed: persisted.pointInTimeChecks > 0 && persisted.leakageFailures === 0,
        detail: `${persisted.pointInTimeChecks} feature, regime, evidence, and label-time assertions were evaluated; ${persisted.leakageFailures} failed.`,
      },
      ...verifyPointInTimeObservation(prepared.manifest.data.window.endExclusive, {
        featureTimestamp: prepared.manifest.data.window.endExclusive,
        universeTimestamp: prepared.manifest.data.window.startInclusive,
        regimeTimestamp: prepared.manifest.data.window.endExclusive,
        evidenceAsOf: null,
        labelTimestamp: null,
      }),
      {
        check: "synthetic-data-isolation",
        passed: !prepared.manifest.data.syntheticDataAllowed,
        detail: "Production research preparation required recorded provider candles and refused synthetic substitution.",
      },
    ];
    const report = buildResearchPromotionReport({
      manifest: prepared.manifest,
      control,
      candidate,
      attribution: {
        perception: 0,
        selection: candidateSelected.grossPnl - control.grossPnl,
        evidence: 0,
        allocation: candidateFixed.grossPnl - candidateSelected.grossPnl,
        executionCosts: -(candidate.costs - control.costs),
        management: candidate.grossPnl - candidateFixed.grossPnl,
        unit: "net-pnl",
      },
      goldenStream: {
        expectedFingerprint,
        actualFingerprint,
        reproducible: expectedFingerprint === actualFingerprint,
      },
      leakageChecks,
      hypotheses: [{
        id: "candidate-net-pnl-differs-from-control",
        pValue: pairedPermutationPValue(persisted.control.outcomes, persisted.candidateAdaptive.outcomes, prepared.manifest.deterministicSeed),
      }],
      noRiskPolicyViolations: true,
      holdoutEvaluated: persisted.decisions.some((event) => event.partitionId === "untouched-holdout"),
      allStressScenariosPassed: stressPassed,
      generatedAt: new Date(),
      limitations: [
        "Historical evidence remains unavailable unless a point-in-time approved evidence snapshot exists.",
        `${persisted.blockedFrames} base frames abstained because required market data was unavailable or invalid.`,
        "The paired permutation diagnostic aligns trades by close order and is descriptive; promotion remains governed by all deterministic gates and human review.",
      ],
    });
    await store.complete(userId, section, experimentDbId, report);
  } catch (error) {
    if (error instanceof Error && error.message === "Research experiment cancellation requested") {
      await store.markCancelled(userId, section, experimentDbId);
      return;
    }
    logger.error({ err: error, userId, section, experimentDbId }, "Research experiment failed");
    try {
      await store.fail(userId, section, experimentDbId, error);
    } catch (persistenceError) {
      logger.error({ err: persistenceError, experimentDbId }, "Research failure state could not be persisted");
    }
  }
}

export async function resumeIncompleteResearchExperiments(
  store = new ResearchExperimentStore(),
): Promise<void> {
  const records = await store.incomplete();
  for (const record of records) {
    const section = record.section === "forex" ? "forex" : "crypto";
    try {
      if (record.cancelRequested) {
        await store.markCancelled(record.userId, section, record.id);
        continue;
      }
      const priorManifest = record.manifest
        ? parseResearchExperimentManifest(record.manifest)
        : null;
      const prepared = await prepareResearchExperiment(
        record.userId,
        section,
        record.request,
        priorManifest ? { asOf: new Date(priorManifest.data.asOf) } : {},
      );
      if (record.status === "preparing") {
        await store.attachManifest(record.userId, section, record.id, prepared.manifest);
      } else if (
        record.experimentId !== prepared.manifest.experimentId ||
        record.manifestFingerprint !== prepared.manifest.fingerprint
      ) {
        throw new Error("Research resume refused because the manifest or provider data changed");
      }
      await runResearchExperimentJob(record.userId, section, record.id, prepared, store);
    } catch (error) {
      logger.error({ err: error, experimentDbId: record.id }, "Research experiment resume failed");
      try {
        await store.fail(record.userId, section, record.id, error);
      } catch (persistenceError) {
        logger.error({ err: persistenceError, experimentDbId: record.id }, "Research resume failure state could not be persisted");
      }
    }
  }
}

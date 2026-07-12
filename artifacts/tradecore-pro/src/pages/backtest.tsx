import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListBacktests,
  useRunBacktest,
  useGetBacktest,
  useDeleteBacktest,
  getListBacktestsQueryKey,
  getGetBacktestQueryKey,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { cn, formatCurrency, formatPercent, formatNumber } from "@/lib/utils";
import {
  FlaskConical,
  Play,
  Trash2,
  Download,
  ChevronDown,
  ChevronUp,
  BarChart2,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Clock,
  RefreshCw,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Config form state
// ---------------------------------------------------------------------------
const SYMBOLS_DEFAULT = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","MATICUSDT","LINKUSDT",
];
const TIMEFRAMES = ["1m","3m","5m","15m","30m","1h","4h","1d"];

// ── Timeframe suitability guard ──────────────────────────────────────────────
// The backtest checks each open trade's stop-loss / take-profit / trailing
// stop ONCE PER CANDLE. So the candle interval must be much finer than how
// long a strategy holds, or trades hit the max-hold timeout before their
// exits can ever trigger — producing a run that's ~all timeouts and tells you
// nothing about the strategies (confirmed: 15m/1h runs came back 94–95%
// timeouts). These are the shipped strategies' holding windows.
const TF_SECONDS: Record<string, number> = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400,
};
const SHORTEST_HOLD_S = 600;  // micro_scalping maxHoldingSeconds (fastest)
const LONGEST_HOLD_S = 3600;  // momentum / volatility maxHoldingSeconds (slowest)

function timeframeAdvice(tf: string): { level: "ok" | "caution" | "bad"; message: string } {
  const s = TF_SECONDS[tf] ?? 60;
  const m = Math.round(s / 60);
  if (s >= LONGEST_HOLD_S) {
    return {
      level: "bad",
      message: `At ${tf}, exits are only checked once every ${m} min. Every strategy holds for ≤ ${LONGEST_HOLD_S / 60} min, so almost every trade will hit the max-hold timeout before its stop-loss or take-profit can trigger — the result won't reflect your strategies. Use 1m.`,
    };
  }
  if (s >= SHORTEST_HOLD_S) {
    return {
      level: "bad",
      message: `At ${tf}, scalping trades (≤ ${SHORTEST_HOLD_S / 60} min hold) time out before a single exit check, and the longer strategies only get a few checks. Most trades will time out. Use 1m for meaningful SL/TP/trailing behaviour.`,
    };
  }
  if (s > 60) {
    return {
      level: "caution",
      message: `1m is recommended. At ${tf}, exits are checked once every ${m} min, so the fastest (scalping) setups are under-resolved.`,
    };
  }
  return {
    level: "ok",
    message: "Exits are checked every candle — stop-loss, take-profit, and trailing behave as they do live.",
  };
}

function isoDate(d: Date) {
  return d.toISOString().split("T")[0];
}

interface RunFormState {
  symbols: string[];
  timeframe: string;
  startDate: string;
  endDate: string;
  startingBalance: number;
  confidenceThreshold: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  riskPercent: number;
  positionSizeUsdt: number;
  maxOpenPositions: number;
  dailyLossLimitUsdt: number;
  marketType: "spot" | "futures";
  leverage: number;
}

function defaultForm(): RunFormState {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 1);
  return {
    symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
    timeframe: "1m",
    startDate: isoDate(start),
    endDate: isoDate(end),
    startingBalance: 1000,
    confidenceThreshold: 65,
    stopLossPercent: 1.5,
    takeProfitPercent: 2.5,
    riskPercent: 0, // 0 = use each strategy's own configured risk% (not a global override)
    positionSizeUsdt: 10,
    maxOpenPositions: 5,
    dailyLossLimitUsdt: 50,
    marketType: "spot",
    leverage: 1,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function statusColor(status: string) {
  switch (status) {
    case "completed": return "text-success";
    case "running":   return "text-primary";
    case "failed":    return "text-destructive";
    case "cancelled": return "text-muted-foreground";
    default:          return "text-muted-foreground";
  }
}

function statusBadge(status: string) {
  switch (status) {
    case "completed": return "default";
    case "running":   return "secondary";
    case "failed":    return "destructive";
    case "cancelled": return "outline";
    default:          return "outline";
  }
}

// ---------------------------------------------------------------------------
// Run Form
// ---------------------------------------------------------------------------
function RunForm({ onStarted }: { onStarted: (id: number) => void }) {
  const [form, setForm] = useState<RunFormState>(defaultForm());
  const [symbolInput, setSymbolInput] = useState(form.symbols.join(", "));
  const [runAnyway, setRunAnyway] = useState(false);
  const { mutate, isPending } = useRunBacktest();

  const tfAdvice = timeframeAdvice(form.timeframe);
  const timeframeBlocks = tfAdvice.level === "bad" && !runAnyway;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (timeframeBlocks) return; // guard: too-coarse timeframe not acknowledged
    const symbols = symbolInput.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    mutate(
      {
        data: {
          ...(form as any),
          symbols,
          startDate: new Date(form.startDate).toISOString(),
          endDate: new Date(form.endDate).toISOString(),
        },
      },
      {
        onSuccess: (data) => {
          onStarted(data.runId);
        },
      }
    );
  }

  function field(label: string, key: keyof RunFormState, type = "number", step?: string) {
    return (
      <div className="space-y-1">
        <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{label}</label>
        <input
          type={type}
          step={step}
          value={form[key] as any}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              [key]: type === "number" ? Number(e.target.value) : e.target.value,
            }))
          }
          className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-4 w-4 text-primary" />
          Configure Backtest
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Symbols */}
          <div className="space-y-1">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Symbols (comma-separated)</label>
            <input
              type="text"
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              placeholder="BTCUSDT, ETHUSDT, ..."
              className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Timeframe */}
          <div className="space-y-1">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Timeframe</label>
            <select
              value={form.timeframe}
              onChange={(e) => { setForm((f) => ({ ...f, timeframe: e.target.value })); setRunAnyway(false); }}
              className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {TIMEFRAMES.map((tf) => (
                <option key={tf} value={tf}>{tf}{tf === "1m" ? " (recommended)" : ""}</option>
              ))}
            </select>

            {/* Timeframe suitability banner — a too-coarse timeframe produces
                an all-timeouts run that doesn't test the strategies. */}
            {tfAdvice.level !== "ok" && (
              <div
                className={cn(
                  "mt-2 rounded border p-2.5 text-xs flex gap-2",
                  tfAdvice.level === "bad"
                    ? "border-destructive/50 bg-destructive/10 text-destructive"
                    : "border-warning/50 bg-warning/10 text-warning",
                )}
              >
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="space-y-1.5">
                  <p className="leading-snug">{tfAdvice.message}</p>
                  {tfAdvice.level === "bad" && (
                    <label className="flex items-center gap-1.5 cursor-pointer select-none text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={runAnyway}
                        onChange={(e) => setRunAnyway(e.target.checked)}
                      />
                      Run anyway — I understand most trades will time out
                    </label>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Date range */}
          <div className="grid grid-cols-2 gap-3">
            {field("Start Date", "startDate", "date")}
            {field("End Date", "endDate", "date")}
          </div>

          {/* Market type + leverage (futures models liquidation) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Market Type</label>
              <select
                value={form.marketType}
                onChange={(e) => setForm((f) => ({ ...f, marketType: e.target.value as "spot" | "futures" }))}
                className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="spot">Spot</option>
                <option value="futures">Futures (USDⓈ-M)</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Leverage {form.marketType !== "futures" && "(futures only)"}
              </label>
              <input
                type="number"
                min={1}
                max={125}
                disabled={form.marketType !== "futures"}
                value={form.leverage}
                onChange={(e) => setForm((f) => ({ ...f, leverage: Number(e.target.value) }))}
                className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
              />
            </div>
          </div>
          {form.marketType === "futures" && (
            <p className="text-[11px] text-muted-foreground -mt-2">
              Leverage models liquidation risk only, not position size (matches the live engine). A stop too close to
              the liquidation price is refused, exactly as the live bot would — so very high leverage may produce few or
              no trades.
            </p>
          )}

          {/* Balance + position */}
          <div className="grid grid-cols-2 gap-3">
            {field("Starting Balance ($)", "startingBalance")}
            {field("Position Size (USDT)", "positionSizeUsdt")}
          </div>

          {/* Strategy params */}
          <div className="grid grid-cols-2 gap-3">
            {field("Confidence Threshold", "confidenceThreshold")}
            {field("Max Open Positions", "maxOpenPositions")}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {field("Stop Loss %", "stopLossPercent", "number", "0.1")}
            {field("Take Profit %", "takeProfitPercent", "number", "0.1")}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {field("Daily Loss Limit ($)", "dailyLossLimitUsdt")}
            {field("Risk % (0 = use each strategy's own)", "riskPercent", "number", "0.1")}
          </div>

          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">
              Leave Risk % at 0 to keep each strategy's own configured risk% from the Strategies page.
              Any other value overrides risk% for every strategy in this run.
            </p>
          </div>

          <EffectiveConfigPreview form={form} />

          <Button type="submit" disabled={isPending || timeframeBlocks} className="w-full gap-2">
            <Play className="h-4 w-4" />
            {isPending ? "Starting…" : timeframeBlocks ? "Choose 1m or tick “Run anyway”" : "Run Backtest"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Effective Backtest Configuration — preview (bug-fix feature)
//
// Calls POST /backtests/preview-config with the form's current override
// values and shows exactly what each strategy will actually use, BEFORE the
// user runs anything. This is what makes the previously-silent
// override-loss bug impossible to miss: if this table ever showed the same
// numbers as the "database" column regardless of what's typed above, that
// would be this bug recurring.
//
// Uses a plain fetch() rather than the generated api-client-react hook,
// since this is a newly-added endpoint and regenerating that client is a
// separate build step (see CHANGES.md) — functionally equivalent, just not
// routed through the generated SDK.
// ---------------------------------------------------------------------------
function EffectiveConfigPreview({ form }: { form: RunFormState }) {
  const [data, setData] = useState<{
    runLevelOverrides: { stopLossPercent: number; takeProfitPercent: number; confidenceThreshold: number; riskPercentOverride: number | null };
    strategies: Array<{
      strategyId: string; strategyName: string; enabled: boolean;
      db: { stopLossPercent: number; takeProfitPercent: number; confidenceThreshold: number; riskPercent: number };
      effective: { stopLossPercent: number; takeProfitPercent: number; confidenceThreshold: number; riskPercent: number };
      riskPercentSource: string;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      fetch("/api/backtests/preview-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stopLossPercent: form.stopLossPercent,
          takeProfitPercent: form.takeProfitPercent,
          confidenceThreshold: form.confidenceThreshold,
          riskPercent: form.riskPercent,
        }),
      })
        .then((r) => r.json())
        .then((json) => { if (!cancelled) setData(json); })
        .catch(() => { if (!cancelled) setData(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 400); // debounce while the user is typing
    return () => { cancelled = true; clearTimeout(t); };
  }, [form.stopLossPercent, form.takeProfitPercent, form.confidenceThreshold, form.riskPercent]);

  return (
    <div className="border border-border rounded-lg p-3 bg-muted/20 space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Effective Backtest Configuration
        </h4>
        {loading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      {!data ? (
        <p className="text-xs text-muted-foreground font-mono">Computing…</p>
      ) : (
        <div className="space-y-1.5">
          {data.strategies.map((s) => (
            <div key={s.strategyId} className="text-[11px] font-mono flex flex-wrap gap-x-3 gap-y-0.5">
              <span className={cn("font-medium", !s.enabled && "text-muted-foreground line-through")}>
                {s.strategyName}
              </span>
              <span className="text-muted-foreground">
                SL {s.db.stopLossPercent}%→<span className="text-foreground">{s.effective.stopLossPercent}%</span>
              </span>
              <span className="text-muted-foreground">
                TP {s.db.takeProfitPercent}%→<span className="text-foreground">{s.effective.takeProfitPercent}%</span>
              </span>
              <span className="text-muted-foreground">
                Conf {s.db.confidenceThreshold}→<span className="text-foreground">{s.effective.confidenceThreshold}</span>
              </span>
              <span className="text-muted-foreground">
                Risk {s.db.riskPercent}%→<span className="text-foreground">{s.effective.riskPercent}%</span>{" "}
                <span className="opacity-60">({s.riskPercentSource})</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run list item
// ---------------------------------------------------------------------------
function RunListItem({
  run,
  isSelected,
  onSelect,
  onDelete,
}: {
  run: any;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        "rounded-lg border p-3 cursor-pointer transition-all",
        isSelected
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/50 bg-card"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium font-mono">#{run.id}</span>
            <Badge variant={statusBadge(run.status) as any} className="text-[10px] uppercase tracking-wider">
              {run.status}
            </Badge>
            <span className="text-xs text-muted-foreground font-mono">{run.timeframe}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {run.symbols.join(", ")}
          </p>
          {run.status === "running" && (
            <div className="mt-1.5">
              <div className="h-1 rounded-full bg-border overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-500"
                  style={{ width: `${run.progress}%` }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">{run.progress}%</span>
            </div>
          )}
          {run.status === "completed" && run.totalPnl != null && (
            <div className="flex items-center gap-3 mt-1.5">
              <span className={cn("text-xs font-mono font-medium", Number(run.totalPnl) >= 0 ? "text-success" : "text-destructive")}>
                {formatCurrency(run.totalPnl, "always")}
              </span>
              <span className="text-xs text-muted-foreground font-mono">
                WR {formatPercent(Number(run.winRate) * 100)}
              </span>
            </div>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-muted-foreground hover:text-destructive transition-colors p-1 shrink-0"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric card
// ---------------------------------------------------------------------------
function Metric({
  label,
  value,
  sub,
  positive,
  negative,
}: {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean;
  negative?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">{label}</p>
        <p className={cn("text-2xl font-bold tracking-tight font-mono",
          positive ? "text-success" : negative ? "text-destructive" : ""
        )}>
          {value}
        </p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Run detail panel
// ---------------------------------------------------------------------------
function RunDetail({ runId, onClose }: { runId: number; onClose: () => void }) {
  const { data, isLoading, refetch } = useGetBacktest(runId, {
    query: {
      queryKey: getGetBacktestQueryKey(runId),
      refetchInterval: (query) => {
        const status = (query.state.data as any)?.run?.status;
        return status === "running" || status === "pending" ? 3000 : false;
      },
    },
  });

  const run = data?.run;
  const trades = data?.trades ?? [];
  const equity = data?.equityCurve ?? [];
  const [tab, setTab] = useState<"overview" | "trades">("overview");

  if (isLoading || !run) {
    return (
      <Card className="h-full flex items-center justify-center">
        <div className="text-muted-foreground font-mono text-sm flex items-center gap-2">
          <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </Card>
    );
  }

  // Running / pending placeholder
  if (run.status === "pending" || run.status === "running") {
    return (
      <Card className="flex flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <span className="font-mono font-bold text-lg">Run #{run.id}</span>
          <Badge variant="secondary">
            <RefreshCw className="h-3 w-3 animate-spin mr-1" /> {run.status}
          </Badge>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs font-mono text-muted-foreground">
            <span>Progress</span><span>{run.progress}%</span>
          </div>
          <div className="h-2 rounded-full bg-border overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${run.progress}%` }} />
          </div>
        </div>
        <p className="text-sm text-muted-foreground font-mono">
          Downloading candles & replaying strategy… results will appear automatically.
        </p>
      </Card>
    );
  }

  if (run.status === "failed") {
    return (
      <Card className="flex flex-col gap-4 p-6">
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          <span className="font-bold">Backtest Failed</span>
        </div>
        <pre className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded p-3 overflow-auto">
          {run.error ?? "Unknown error"}
        </pre>
      </Card>
    );
  }

  // Compute derived data for charts
  const winLossPie = [
    { name: "Wins", value: run.winningTrades ?? 0 },
    { name: "Losses", value: run.losingTrades ?? 0 },
  ];
  const PIE_COLORS = ["hsl(140,100%,45%)", "hsl(350,100%,60%)"];

  // Monthly returns from equity curve
  const monthlyMap = new Map<string, number>();
  let prevBal: number | null = null;
  for (const point of equity) {
    const month = new Date(point.timestamp).toISOString().slice(0, 7);
    if (prevBal !== null) {
      const ret = point.balance - prevBal;
      monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + ret);
    }
    prevBal = point.balance;
  }
  const monthlyData = Array.from(monthlyMap.entries()).map(([month, ret]) => ({
    month,
    return: Number(ret.toFixed(2)),
  }));

  // Symbol breakdown from trades
  const symbolMap = new Map<string, { pnl: number; count: number }>();
  for (const t of trades) {
    const prev = symbolMap.get(t.symbol) ?? { pnl: 0, count: 0 };
    symbolMap.set(t.symbol, { pnl: prev.pnl + (t.pnl ?? 0), count: prev.count + 1 });
  }
  const symbolData = Array.from(symbolMap.entries())
    .map(([symbol, d]) => ({ symbol, pnl: Number(d.pnl.toFixed(2)), count: d.count }))
    .sort((a, b) => b.pnl - a.pnl);

  // Exit reason breakdown
  const exitMap = new Map<string, number>();
  for (const t of trades) {
    const r = t.exitReason ?? "unknown";
    exitMap.set(r, (exitMap.get(r) ?? 0) + 1);
  }
  const exitData = Array.from(exitMap.entries()).map(([reason, count]) => ({ reason, count }));

  const totalPnl = run.totalPnl ?? 0;
  const isProfit = totalPnl >= 0;
  const totalReturn = (run.totalReturn ?? 0) * 100;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-bold text-lg font-mono">Run #{run.id}</h2>
          <p className="text-xs text-muted-foreground font-mono">
            {run.symbols.join(", ")} · {run.timeframe} ·{" "}
            {new Date(run.startDate).toLocaleDateString()} →{" "}
            {new Date(run.endDate).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/backtests/${run.id}/export?format=csv`}
            download
            className="inline-flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 rounded border border-border hover:border-primary/50 transition-colors"
          >
            <Download className="h-3 w-3" /> CSV
          </a>
          <a
            href={`/api/backtests/${run.id}/export?format=json`}
            download
            className="inline-flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 rounded border border-border hover:border-primary/50 transition-colors"
          >
            <Download className="h-3 w-3" /> JSON
          </a>
        </div>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric
          label="Net P&L"
          value={formatCurrency(totalPnl, "always")}
          sub={`${isProfit ? "+" : ""}${totalReturn.toFixed(2)}%`}
          positive={isProfit}
          negative={!isProfit}
        />
        <Metric
          label="Win Rate"
          value={formatPercent(Number(run.winRate ?? 0) * 100)}
          sub={`${run.winningTrades ?? 0}W / ${run.losingTrades ?? 0}L`}
        />
        <Metric
          label="Profit Factor"
          value={(run.profitFactor ?? 0).toFixed(2)}
          positive={(run.profitFactor ?? 0) > 1}
          negative={(run.profitFactor ?? 0) < 1}
        />
        <Metric
          label="Max Drawdown"
          value={`${((run.maxDrawdown ?? 0) * 100).toFixed(1)}%`}
          negative
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric label="Total Trades" value={String(run.totalTrades ?? 0)} />
        <Metric label="Sharpe Ratio" value={(run.sharpeRatio ?? 0).toFixed(2)} positive={(run.sharpeRatio ?? 0) > 1} />
        <Metric label="Sortino Ratio" value={(run.sortinoRatio ?? 0).toFixed(2)} positive={(run.sortinoRatio ?? 0) > 1} />
        <Metric label="Expectancy" value={formatCurrency(run.expectancy ?? 0, "always")} positive={(run.expectancy ?? 0) > 0} negative={(run.expectancy ?? 0) < 0} />
      </div>

      {/* Additional metrics row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric label="Starting Balance" value={formatCurrency(run.startingBalance)} />
        <Metric label="Ending Balance" value={formatCurrency(run.endingBalance ?? run.startingBalance)} positive={isProfit} negative={!isProfit} />
        <Metric label="Avg Win" value={formatCurrency(run.averageWin ?? 0, "always")} positive />
        <Metric label="Avg Loss" value={formatCurrency(run.averageLoss ?? 0, "always")} negative />
      </div>

      {/* Effective Backtest Configuration — the user should always know
          exactly which values this run actually used. */}
      {(() => {
        const effConfig = run.effectiveConfig as { summary?: any[]; runLevelOverrides?: any } | null;
        const summary = effConfig?.summary ?? [];
        if (summary.length === 0) return null;
        return (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Effective Backtest Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="overflow-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground uppercase tracking-wider">
                      <th className="text-left px-2 py-1.5">Strategy</th>
                      <th className="text-right px-2 py-1.5">Stop Loss %</th>
                      <th className="text-right px-2 py-1.5">Take Profit %</th>
                      <th className="text-right px-2 py-1.5">Confidence ≥</th>
                      <th className="text-right px-2 py-1.5">Risk %</th>
                      <th className="text-right px-2 py-1.5">Risk % Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map((s) => (
                      <tr key={s.strategyId} className="border-b border-border/50">
                        <td className="px-2 py-1.5">{s.strategyName}</td>
                        <td className="px-2 py-1.5 text-right">
                          <span className="text-muted-foreground">{s.db.stopLossPercent}%</span> → {s.effective.stopLossPercent}%
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <span className="text-muted-foreground">{s.db.takeProfitPercent}%</span> → {s.effective.takeProfitPercent}%
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <span className="text-muted-foreground">{s.db.confidenceThreshold}</span> → {s.effective.confidenceThreshold}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <span className="text-muted-foreground">{s.db.riskPercent}%</span> → {s.effective.riskPercent}%
                        </td>
                        <td className="px-2 py-1.5 text-right text-muted-foreground">{s.riskPercentSource}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(["overview", "trades"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 text-sm font-mono uppercase tracking-wider transition-colors",
              tab === t
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t === "overview" ? "Charts" : `Trades (${trades.length})`}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          {/* Equity curve */}
          {equity.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-primary" /> Equity Curve
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={equity.map((p) => ({ ...p, timestamp: new Date(p.timestamp).toLocaleDateString() }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="timestamp" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => `$${v.toFixed(0)}`} />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                      formatter={(v: any) => [`$${Number(v).toFixed(2)}`, "Balance"]}
                    />
                    <ReferenceLine y={run.startingBalance} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" />
                    <Line
                      type="monotone"
                      dataKey="balance"
                      stroke={isProfit ? "hsl(140,100%,45%)" : "hsl(350,100%,60%)"}
                      dot={false}
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Drawdown */}
          {equity.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-destructive" /> Drawdown
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={equity.map((p) => ({ ...p, timestamp: new Date(p.timestamp).toLocaleDateString(), pct: -(p.drawdown * 100) }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="timestamp" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => `${v.toFixed(1)}%`} />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                      formatter={(v: any) => [`${Math.abs(Number(v)).toFixed(2)}%`, "Drawdown"]}
                    />
                    <Bar dataKey="pct" fill="hsl(350,100%,60%)" opacity={0.7} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Win/Loss pie */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Win / Loss Distribution</CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-center">
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart>
                    <Pie data={winLossPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} label={({ name, value }) => `${name}: ${value}`} labelLine={false}>
                      {winLossPie.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Monthly returns */}
            {monthlyData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Monthly Returns</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={monthlyData}>
                      <XAxis dataKey="month" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => `$${v}`} />
                      <Tooltip
                        contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
                        formatter={(v: any) => [`$${Number(v).toFixed(2)}`, "Return"]}
                      />
                      <ReferenceLine y={0} stroke="hsl(var(--border))" />
                      <Bar dataKey="return">
                        {monthlyData.map((d, i) => (
                          <Cell key={i} fill={d.return >= 0 ? "hsl(140,100%,45%)" : "hsl(350,100%,60%)"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Symbol breakdown */}
          {symbolData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <BarChart2 className="h-4 w-4" /> P&L by Symbol
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={Math.max(120, symbolData.length * 30)}>
                  <BarChart data={symbolData} layout="vertical">
                    <XAxis type="number" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => `$${v}`} />
                    <YAxis type="category" dataKey="symbol" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={70} />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
                      formatter={(v: any) => [`$${Number(v).toFixed(2)}`, "P&L"]}
                    />
                    <ReferenceLine x={0} stroke="hsl(var(--border))" />
                    <Bar dataKey="pnl">
                      {symbolData.map((d, i) => (
                        <Cell key={i} fill={d.pnl >= 0 ? "hsl(140,100%,45%)" : "hsl(350,100%,60%)"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Exit reason breakdown */}
          {exitData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Exit Reason Breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-4 flex-wrap">
                  {exitData.map((d) => (
                    <div key={d.reason} className="flex items-center gap-2">
                      <div className={cn("h-2 w-2 rounded-full",
                        d.reason === "take_profit" ? "bg-success" :
                        d.reason === "stop_loss" ? "bg-destructive" : "bg-muted-foreground"
                      )} />
                      <span className="text-xs font-mono text-muted-foreground">
                        {d.reason.replace("_", " ")}: <span className="text-foreground font-medium">{d.count}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {tab === "trades" && (
        <Card>
          <CardContent className="p-0 overflow-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border">
                  {["Symbol", "Entry", "Exit", "Entry $", "Exit $", "SL %", "TP %", "Qty", "Fees", "P&L", "P&L%", "Reason", "Duration"].map((h) => (
                    <th key={h} className="text-left px-3 py-2.5 text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2 font-medium">{t.symbol}</td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {t.entryTime ? new Date(t.entryTime).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {t.exitTime ? new Date(t.exitTime).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2">{t.entryPrice?.toFixed(4)}</td>
                    <td className="px-3 py-2">{t.exitPrice?.toFixed(4) ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {t.slPercent != null ? `${t.slPercent.toFixed(2)}%` : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {t.tpPercent != null ? `${t.tpPercent.toFixed(2)}%` : "—"}
                    </td>
                    <td className="px-3 py-2">{t.quantity?.toFixed(4)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{t.fees ? `$${t.fees.toFixed(4)}` : "—"}</td>
                    <td className={cn("px-3 py-2 font-medium", (t.pnl ?? 0) >= 0 ? "text-success" : "text-destructive")}>
                      {t.pnl != null ? formatCurrency(t.pnl, "always") : "—"}
                    </td>
                    <td className={cn("px-3 py-2", (t.pnlPercent ?? 0) >= 0 ? "text-success" : "text-destructive")}>
                      {t.pnlPercent != null ? `${t.pnlPercent >= 0 ? "+" : ""}${t.pnlPercent.toFixed(2)}%` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn("px-1.5 py-0.5 rounded text-[10px] uppercase",
                        t.exitReason === "take_profit" ? "bg-success/10 text-success" :
                        t.exitReason === "stop_loss" ? "bg-destructive/10 text-destructive" :
                        "bg-muted text-muted-foreground"
                      )}>
                        {t.exitReason?.replace("_", " ") ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {t.durationSeconds != null
                        ? t.durationSeconds < 3600
                          ? `${Math.round(t.durationSeconds / 60)}m`
                          : `${(t.durationSeconds / 3600).toFixed(1)}h`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {trades.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground font-mono">
                No trades recorded in this backtest.
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function Backtest() {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(true);

  const { data: runs = [], refetch: refetchList } = useListBacktests({
    query: {
      queryKey: getListBacktestsQueryKey(),
      refetchInterval: (query) => {
        const list = query.state.data as any[];
        const hasRunning = list?.some((r) => r.status === "running" || r.status === "pending");
        return hasRunning ? 3000 : 15000;
      },
    },
  });

  const { mutate: deleteRun } = useDeleteBacktest();

  function handleDelete(id: number) {
    deleteRun({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBacktestsQueryKey() });
        if (selectedRunId === id) setSelectedRunId(null);
      },
    });
  }

  function handleStarted(id: number) {
    setSelectedRunId(id);
    setShowForm(false);
    queryClient.invalidateQueries({ queryKey: getListBacktestsQueryKey() });
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FlaskConical className="h-6 w-6 text-primary" /> Backtesting Lab
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Replay historical candles using the live strategy engine. Fees and slippage included.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowForm((v) => !v)}
          className="gap-1.5 font-mono text-xs"
        >
          {showForm ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {showForm ? "Hide Form" : "New Run"}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-start">
        {/* Left column: form + run list */}
        <div className="space-y-4">
          {showForm && <RunForm onStarted={handleStarted} />}

          {/* Run list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
                Saved Runs ({runs.length})
              </h3>
              <button
                onClick={() => refetchList()}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-2 max-h-[600px] overflow-auto pr-1">
              {runs.length === 0 && (
                <div className="text-xs text-muted-foreground font-mono py-6 text-center border border-dashed border-border rounded-lg">
                  No backtests yet. Configure and run one above.
                </div>
              )}
              {runs.map((run: any) => (
                <RunListItem
                  key={run.id}
                  run={run}
                  isSelected={selectedRunId === run.id}
                  onSelect={() => setSelectedRunId(run.id)}
                  onDelete={() => handleDelete(run.id)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Right column: detail */}
        <div>
          {selectedRunId ? (
            <RunDetail
              key={selectedRunId}
              runId={selectedRunId}
              onClose={() => setSelectedRunId(null)}
            />
          ) : (
            <div className="border border-dashed border-border rounded-xl h-[400px] flex items-center justify-center text-muted-foreground font-mono text-sm">
              Select a run from the list to view results
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

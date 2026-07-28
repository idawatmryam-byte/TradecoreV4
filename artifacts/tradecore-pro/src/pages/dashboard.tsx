import { useGetBotStatus, useGetScannerData, useStartBot, useStopBot, useGetBinanceCredentials, useGetOandaCredentials, useGetConfig, useGetCopilotInbox, getGetBotStatusQueryKey, getGetScannerDataQueryKey, getGetTradesQueryKey, getGetBinanceCredentialsQueryKey, getGetOandaCredentialsQueryKey, getGetConfigQueryKey, getGetCopilotInboxQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui";
import { formatCurrency, formatPercent, formatNumber } from "@/lib/utils";
import { Link } from "wouter";
import { Power, Square, Activity, TrendingUp, AlertTriangle, ArrowUpRight, ArrowDownRight, WifiOff, X, Loader2, ChevronDown, ChevronUp, Clock, CheckCircle2, Circle, ArrowRight } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";
import { BlockingBanner, MarketMonitor, DecisionPanel } from "@/components/verification";
import { PositionChart } from "@/components/position-chart";
import { CorrelationHeatMap } from "@/components/correlation-heatmap";
import { useState, type ReactNode } from "react";
import { useSection, sectionHeaders } from "@/lib/section";
import { useIsDemo } from "@/lib/account";
import { CollapsibleSection, StatTile, EmptyState } from "@/components/patterns";
import { CopilotSummary } from "@/components/copilot-summary";

/** Live per-position feed from GET /trades/monitor/active — entry vs current
 *  price, the actual SL/TP levels, and unrealized P&L, refreshed every 5s. */
interface ActivePosition {
  tradeId: number;
  symbol: string;
  side: "long" | "short";
  strategyName: string | null;
  marketType: string;
  leverage: number | null;
  entryPrice: number;
  currentPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  tp1Price: number | null;
  remainingQuantity: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  breakEvenActive: boolean;
  trailingStopActive: boolean;
  tp1Filled: boolean;
  holdingSeconds: number;
}

function formatHeld(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * Minimizable cockpit panel. Every dashboard section wraps in one of these —
 * a slim title bar with a chevron; clicking it collapses the panel to just
 * the bar. Collapsed/expanded state persists per panel in localStorage, so
 * the cockpit layout survives reloads.
 */
function ProgressBar({ value, colorClass }: { value: number, colorClass: string }) {
  return (
    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
      <div className={cn("h-full transition-all duration-500", colorClass)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

/** The shared tile, named locally so the many call sites below stay short. */
function Stat({ label, value, valueClass, sub }: {
  label: string; value: ReactNode; valueClass?: string; sub?: ReactNode;
}) {
  return <StatTile label={label} value={value} valueClass={valueClass} footer={sub} />;
}

/** The Open Positions panel body — full trade status per open position plus
 *  the two-step manual close. Rendered full-width at the top of the cockpit. */
function PositionsPanel({ positions, error, loading, confirmingClose, closingId, onArmClose, onClose }: {
  positions: ActivePosition[] | undefined;
  error: boolean;
  loading: boolean;
  confirmingClose: number | null;
  closingId: number | null;
  onArmClose: (tradeId: number | null) => void;
  onClose: (tradeId: number, symbol: string) => void;
}) {
  // Tap a card to expand it full-width with a live 1m chart of the position
  // (entry/SL/TP levels drawn on the candles). Tap again to collapse.
  const [chartTradeId, setChartTradeId] = useState<number | null>(null);
  return (
    <div className="bg-card">
      {positions && positions.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 p-3">
          {positions.map((p) => {
            const isProfit = p.unrealizedPnl >= 0;
            const isClosing = closingId === p.tradeId;
            const isConfirming = confirmingClose === p.tradeId;
            const chartOpen = chartTradeId === p.tradeId;
            return (
              <div
                key={p.tradeId}
                role="button"
                tabIndex={0}
                onClick={() => setChartTradeId(chartOpen ? null : p.tradeId)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setChartTradeId(chartOpen ? null : p.tradeId); }}
                className={cn(
                  "rounded-lg border border-border/60 p-4 bg-background/40 hover:bg-muted/20 transition-colors cursor-pointer",
                  chartOpen && "md:col-span-2 xl:col-span-3 border-primary/40",
                )}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-lg">{p.symbol}</span>
                    <Badge variant={p.side === "long" ? "success" : "destructive"} className="h-5 px-1.5 text-[10px]">
                      {p.side}{p.marketType === "futures" && p.leverage ? ` ${p.leverage}×` : ""}
                    </Badge>
                    {p.breakEvenActive && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">BE</Badge>}
                    {p.trailingStopActive && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">TRAIL</Badge>}
                    {p.tp1Filled && <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-success">TP1 ✓</Badge>}
                  </div>
                  <div className={cn("text-right font-mono font-bold", isProfit ? "text-success" : "text-destructive")}>
                    <div className="flex items-center justify-end gap-1">
                      {isProfit ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                      {formatCurrency(p.unrealizedPnl, "always")}
                    </div>
                    <span className="block text-[9px] font-normal text-muted-foreground">
                      {p.unrealizedPnlPercent >= 0 ? "+" : ""}{p.unrealizedPnlPercent.toFixed(2)}% unrealized
                    </span>
                  </div>
                </div>
                {p.strategyName && (
                  <div className="text-[13px] text-muted-foreground mb-2">
                    {p.strategyName} · held {formatHeld(p.holdingSeconds)}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 text-[13px] font-mono text-muted-foreground">
                  <div>
                    <span className="block opacity-50 mb-0.5">Entry → Now</span>
                    <span className="text-foreground">
                      {formatNumber(p.entryPrice, 4)} → {formatNumber(p.currentPrice, 4)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="block opacity-50 mb-0.5">Size</span>
                    <span className="text-foreground">{formatNumber(p.remainingQuantity, 4)}</span>
                  </div>
                  <div>
                    <span className="block opacity-50 mb-0.5">Stop Loss</span>
                    <span className="text-destructive">{formatNumber(p.stopLossPrice, 4)}</span>
                  </div>
                  <div className="text-right">
                    <span className="block opacity-50 mb-0.5">Take Profit</span>
                    <span className="text-success">
                      {p.tp1Price != null && !p.tp1Filled
                        ? `${formatNumber(p.tp1Price, 4)} / ${formatNumber(p.takeProfitPrice, 4)}`
                        : formatNumber(p.takeProfitPrice, 4)}
                    </span>
                  </div>
                </div>
                {/* stopPropagation: the close controls must never toggle the chart */}
                <div className="mt-3" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  {isConfirming ? (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        className="flex-1 h-8 text-[13px] gap-1.5"
                        disabled={isClosing}
                        onClick={() => onClose(p.tradeId, p.symbol)}
                      >
                        {isClosing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                        Confirm close at market
                      </Button>
                      <Button size="sm" variant="outline" className="text-[13px]" disabled={isClosing} onClick={() => onArmClose(null)}>
                        Keep
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-8 text-[13px] gap-1.5 text-muted-foreground hover:text-destructive hover:border-destructive/50"
                      onClick={() => onArmClose(p.tradeId)}
                    >
                      <X className="h-3.5 w-3.5" /> Close Position
                    </Button>
                  )}
                </div>
                {chartOpen ? (
                  <div onClick={(e) => e.stopPropagation()}>
                    <PositionChart
                      symbol={p.symbol}
                      marketType={p.marketType}
                      side={p.side}
                      quantity={p.remainingQuantity}
                      entryPrice={p.entryPrice}
                      stopLossPrice={p.stopLossPrice}
                      takeProfitPrice={p.takeProfitPrice}
                      tp1Price={p.tp1Price}
                      tp1Filled={p.tp1Filled}
                    />
                    <p className="mt-1.5 text-center text-[13px] text-muted-foreground">
                      Tap the card to hide the chart
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-center text-[13px] text-muted-foreground/60">
                    Tap for live chart · entry / SL / TP levels
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <div className="p-8 text-center text-destructive flex flex-col items-center justify-center">
          <WifiOff className="h-8 w-8 mb-3 opacity-50" />
          <p className="text-sm">Unable to load positions</p>
          <p className="text-[13px] text-muted-foreground mt-1 normal-case">Open positions may still exist — check the exchange directly.</p>
        </div>
      )}
      {!error && loading && (
        <div className="p-8 text-center text-muted-foreground">
          <p className="text-sm">Loading positions…</p>
        </div>
      )}
      {!error && !loading && (!positions || positions.length === 0) && (
        <div className="p-8 text-center text-muted-foreground flex flex-col items-center justify-center">
          <AlertTriangle className="h-8 w-8 mb-3 opacity-20" />
          <p className="text-sm">No active positions</p>
          <p className="text-[13px] mt-1 normal-case">Trades opened by the engine appear here with live P&L and controls.</p>
        </div>
      )}
    </div>
  );
}

/**
 * Post-signup setup guide, tracked against LIVE state so each step ticks
 * itself. Section-aware (Binance for crypto, OANDA for forex), dismissible,
 * and it disappears once setup is complete.
 *
 * The path depends on where the section actually executes, which a new
 * account resolves to DEMO — the engine creates every new section with
 * executionTarget "demo" and mode "copilot" (botEngine.loadConfig). So:
 *
 *   DEMO  no keys, no exchange, no funds. Start the engine and, in Co-Pilot,
 *         approve the first recommendation. Connecting a broker is offered as
 *         a later, deliberate step rather than the price of entry.
 *   LIVE  the original path: connect the section's broker keys → review the
 *         risk plan → press Start.
 *
 * Getting this wrong is worse than an ugly banner: a demo-first product whose
 * first screen demands API keys has thrown away the reason it is demo-first.
 * An earlier version of this component hardcoded the keys step for everyone,
 * so a brand-new account was asked for Binance credentials it did not need
 * and the checklist could never reach "done".
 */
function SetupChecklist() {
  const isDemo = useIsDemo();
  const { section, setSection } = useSection();
  const forex = section === "forex";
  const dismissKey = `tc-onboard-dismissed:${section}`;
  const riskKey = `tc-onboard-risk:${section}`;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(dismissKey) === "1"; } catch { return false; }
  });
  const [riskReviewed, setRiskReviewed] = useState<boolean>(() => {
    try { return localStorage.getItem(riskKey) === "1"; } catch { return false; }
  });

  const { data: config } = useGetConfig({ query: { queryKey: getGetConfigQueryKey() } });
  const demoTarget = config?.executionTarget === "demo";
  const copilot = config?.mode === "copilot";
  // Forex demo needs the platform's own OANDA practice token — OANDA
  // publishes no public market data, so a keyless forex demo is impossible
  // rather than merely unconfigured. When it is missing, promising "no broker
  // needed" and then refusing to start is the worst of both worlds.
  const demoBlocked = demoTarget && config?.demoDataAvailable === false;

  // Credential queries are pointless in demo — skip the requests entirely
  // rather than fetching and ignoring them.
  const binance = useGetBinanceCredentials({
    query: { queryKey: getGetBinanceCredentialsQueryKey(), enabled: !forex && !demoTarget },
  });
  const oanda = useGetOandaCredentials({
    query: { queryKey: getGetOandaCredentialsQueryKey(), enabled: forex && !demoTarget },
  });
  const { data: bot } = useGetBotStatus({ query: { queryKey: getGetBotStatusQueryKey() } });
  // In Co-Pilot nothing executes on its own, so "acted on a recommendation" is
  // the real finish line. The inbox defaults to `created` (the actionable
  // ones), so the resolved statuses must be asked for explicitly — querying
  // the default and looking for a non-created row would never match.
  const ACTED = "executed,rejected,superseded";
  const inbox = useGetCopilotInbox(
    { status: ACTED, limit: 1 },
    { query: { queryKey: getGetCopilotInboxQueryKey({ status: ACTED, limit: 1 }), enabled: demoTarget && copilot } },
  );

  const keysDone = forex ? !!oanda.data?.configured : !!binance.data?.configured;
  const started = !!bot?.running;
  // Starting the engine is only possible once a config exists, so a running
  // engine implies the risk plan was set — tick it regardless of the local flag.
  const riskDone = riskReviewed || started;
  const actedOnPlan = (inbox.data?.recommendations ?? []).length > 0;

  const dismiss = () => { try { localStorage.setItem(dismissKey, "1"); } catch { /* private mode */ } setDismissed(true); };
  const markRiskReviewed = () => { try { localStorage.setItem(riskKey, "1"); } catch { /* private mode */ } setRiskReviewed(true); };

  type Step = {
    done: boolean;
    title: string;
    detail: string;
    cta: string;
    href?: string;
    onClick?: () => void;
  };

  // Demo needs no broker, so the keys step is absent rather than pre-ticked —
  // a struck-through "Connect your exchange keys" would still tell a new user
  // that keys are part of this, which is the thing being fixed.
  const steps: Step[] = demoTarget
    ? [
        demoBlocked
          ? {
              // Say it plainly instead of offering a START that will be
              // refused. This is a property of the deployment, not something
              // the user can fix from Settings, so the only honest action is
              // the section that genuinely needs no credentials.
              done: false,
              title: "Forex demo isn't available here",
              // Deliberately does NOT name the environment variables. They are
              // set by whoever runs the deployment, not by the person reading
              // this, so printing them turns an actionable message into a wall
              // of text about someone else's job. The one thing this reader
              // CAN do is switch to Crypto.
              detail:
                "Simulated forex needs a data source this deployment doesn't have. Crypto needs no credentials and works right now — or connect your own OANDA account and switch this section to Live.",
              cta: "Go to Crypto",
              onClick: () => setSection("crypto"),
            }
          : {
              done: started,
              title: "Start the engine",
              detail: forex
                ? `No broker needed — this section trades a simulated $${(config?.demoStartingBalanceUsdt ?? 100000).toLocaleString()} account against live prices. The engine only trades while the forex market is open.`
                : `No API keys needed — this section trades a simulated $${(config?.demoStartingBalanceUsdt ?? 10000).toLocaleString()} account against live prices. Press Start on the cockpit above.`,
              cta: started ? "Running" : "Go to Start",
              onClick: () => window.scrollTo({ top: 0, behavior: "smooth" }),
            },
        // Both remaining steps presuppose an engine that can run. Listing
        // "approve your first trade" under a section that cannot produce one
        // would just be a step that never ticks.
        ...(copilot && !demoBlocked
          ? [{
              done: actedOnPlan,
              title: "Approve your first trade",
              detail:
                "You're in Co-Pilot, so the engine recommends and you decide — it will not open a position on its own. " +
                "Recommendations land in the Co-Pilot inbox with the full reasoning behind them.",
              cta: actedOnPlan ? "Done" : "Open Co-Pilot",
              href: "/copilot",
            } satisfies Step]
          : []),
        ...(demoBlocked
          ? []
          : [{
              done: riskDone,
              title: "Set your risk plan",
              detail: "Choose the dollars you're willing to lose and to target per trade — the engine derives size, stop, and target from that. It applies to demo and live alike.",
              cta: riskDone ? "Reviewed" : "Review risk",
              href: "/settings",
              onClick: markRiskReviewed,
            } satisfies Step]),
      ]
    : [
        {
          done: keysDone,
          title: forex ? "Connect your OANDA account" : "Connect your exchange keys",
          detail: forex
            ? "Add an OANDA API token + account id. Start on a practice account — no real funds at risk."
            : "Add your Binance API key + secret. Prefer to try it first? Switch this section to Demo in Settings — it trades simulated money against live prices, with no keys at all.",
          cta: keysDone ? "Connected" : "Connect",
          href: "/settings",
        },
        {
          done: riskDone,
          title: "Set your risk plan",
          detail: "Choose the dollars you're willing to lose and to target per trade — the engine derives size, stop, and target from that.",
          cta: riskDone ? "Reviewed" : "Review risk",
          href: "/settings",
          onClick: markRiskReviewed,
        },
        {
          done: started,
          title: "Start the engine",
          detail: forex
            ? "Press Start on the cockpit. The engine only trades while the forex market is open."
            : "Press Start on the cockpit above — the engine begins scanning immediately.",
          cta: started ? "Running" : "Go to Start",
          onClick: () => window.scrollTo({ top: 0, behavior: "smooth" }),
        },
      ];

  const completed = steps.filter((s) => s.done).length;
  const allDone = completed === steps.length;

  // Waiting for config avoids a flash of the live checklist on a demo account.
  if (isDemo || dismissed || allDone || !config) return null;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border",
        // A blocker is not progress. Counting "0 of 1 done" against something
        // the user cannot complete reads as a task they are failing.
        demoBlocked ? "border-warning/40 bg-warning/5" : "border-primary/40 bg-primary/5",
      )}
    >
      <div className={cn(
        "flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5",
        demoBlocked ? "border-warning/20" : "border-primary/20",
      )}>
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {demoBlocked ? "This section can't run here" : `Finish setting up — ${completed} of ${steps.length} done`}
          </div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {demoBlocked
              ? "Forex needs a market-data source this deployment doesn't have."
              : demoTarget
                ? "You're in Demo — simulated money, live prices, no exchange account required."
                : `A few steps to your first ${forex ? "forex" : "crypto"} trade.`}
          </p>
        </div>
        <button type="button" onClick={dismiss} aria-label="Dismiss setup guide" className="shrink-0 text-muted-foreground hover:text-foreground transition-colors">
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* The action drops BELOW the text on a phone. Side by side, a shrink-0
          button left the description about half the width, so it wrapped into
          a tall ragged column beside a floating button. */}
      <ol className="divide-y divide-primary/10">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-3 px-4 py-3 sm:px-5">
            {s.done
              ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
              : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 flex-1">
              <div className={cn("text-sm font-medium", s.done && "text-muted-foreground line-through")}>{s.title}</div>
              {!s.done && (
                <>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{s.detail}</p>
                  <div className="mt-2 sm:hidden">
                    {s.href
                      ? <Link href={s.href}><Button size="sm" variant="outline" className="gap-1.5" onClick={s.onClick}>{s.cta} <ArrowRight className="h-3.5 w-3.5" /></Button></Link>
                      : <Button size="sm" variant="outline" className="gap-1.5" onClick={s.onClick}>{s.cta} <ArrowRight className="h-3.5 w-3.5" /></Button>}
                  </div>
                </>
              )}
            </div>
            {!s.done && (
              <div className="hidden shrink-0 sm:block">
                {s.href
                  ? <Link href={s.href}><Button size="sm" variant="outline" className="gap-1.5" onClick={s.onClick}>{s.cta} <ArrowRight className="h-3.5 w-3.5" /></Button></Link>
                  : <Button size="sm" variant="outline" className="gap-1.5" onClick={s.onClick}>{s.cta} <ArrowRight className="h-3.5 w-3.5" /></Button>}
              </div>
            )}
          </li>
        ))}
      </ol>
      {demoTarget && (
        <div className="px-4 sm:px-5 py-2.5 border-t border-primary/20 text-[11px] text-muted-foreground">
          Ready for real money later?{" "}
          <Link href="/settings" className="text-primary hover:underline">
            Connect {forex ? "OANDA" : "an exchange"} and switch to Live
          </Link>{" "}
          — a deliberate step, never the default.
        </div>
      )}
    </div>
  );
}

/** Server payload from GET /market/forex-hours (pure calendar math — works
 *  even while the forex engine is stopped). */
interface ForexHoursStatus {
  now: string;
  currency: { open: boolean; nextOpen: string | null; nextClose: string | null };
  metalsAndIndices: { open: boolean; nextOpen: string | null; nextClose: string | null };
}

/** "Sun 22:00" in the VIEWER'S timezone — the server sends UTC instants. */
function formatBoundary(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** "in 26h" / "in 45m" until the given instant. */
function formatUntil(iso: string): string {
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
  if (mins < 90) return `in ${mins}m`;
  return `in ${Math.round(mins / 60)}h`;
}

/**
 * Forex-only banner: is the market tradeable RIGHT NOW? Answers the #1
 * confusion of a 24/7-crypto user looking at a quiet forex engine on a
 * weekend — the engine isn't broken, the market is closed. Also surfaces
 * the metals/indices daily maintenance break when currencies are open but
 * gold/index CFDs briefly aren't.
 */
function ForexMarketBanner() {
  const { section } = useSection();
  const { data } = useQuery<ForexHoursStatus>({
    queryKey: ["forex-market-hours"],
    enabled: section === "forex",
    refetchInterval: 60_000,
    queryFn: async () => {
      const res = await fetch("/api/market/forex-hours", { credentials: "same-origin", headers: sectionHeaders() });
      if (!res.ok) throw new Error("forex hours fetch failed");
      return res.json();
    },
  });
  if (section !== "forex" || !data) return null;

  const fx = data.currency;
  const metals = data.metalsAndIndices;
  return (
    <div className={cn(
      "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-4 py-2.5 text-[13px] font-mono",
      fx.open ? "border-success/30 bg-success/5" : "border-warning/40 bg-warning/10",
    )}>
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        {fx.open && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />}
        <span className={cn("relative inline-flex rounded-full h-2.5 w-2.5", fx.open ? "bg-success" : "bg-warning")} />
      </span>
      <span className={cn("font-bold", fx.open ? "text-success" : "text-warning")}>
        {fx.open ? "Forex market open" : "Forex market closed"}
      </span>
      <span className="text-muted-foreground">
        {fx.open && fx.nextClose != null && `closes ${formatBoundary(fx.nextClose)} (${formatUntil(fx.nextClose)})`}
        {!fx.open && fx.nextOpen != null && `reopens ${formatBoundary(fx.nextOpen)} (${formatUntil(fx.nextOpen)})`}
      </span>
      {fx.open && !metals.open && metals.nextOpen != null && (
        <span className="text-muted-foreground flex items-center gap-1.5 basis-full sm:basis-auto">
          <Clock className="h-3 w-3 shrink-0" />
          Gold &amp; indices on daily break — back {formatBoundary(metals.nextOpen)}
        </span>
      )}
    </div>
  );
}

export function Dashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: bot, isLoading: botLoading, isError: botError } = useGetBotStatus({ query: { refetchInterval: 5000, queryKey: getGetBotStatusQueryKey() } });
  const { data: scanner, isLoading: scannerLoading, isError: scannerError } = useGetScannerData({ query: { refetchInterval: 15000, queryKey: getGetScannerDataQueryKey() } });
  // Raw fetch here MUST carry the X-Section header — without it the server
  // defaults to "crypto" and crypto positions render on the Forex dashboard
  // (observed live). Section is also part of the query key so a tab switch
  // can never show the other section's cached rows.
  const { section } = useSection();
  const { data: positions, isLoading: tradesLoading, isError: tradesError } = useQuery<ActivePosition[]>({
    queryKey: ["trades-monitor-active", section],
    refetchInterval: 5000,
    queryFn: async () => {
      const res = await fetch("/api/trades/monitor/active", { credentials: "same-origin", headers: sectionHeaders() });
      if (!res.ok) throw new Error("monitor fetch failed");
      return res.json();
    },
  });

  // Two-step close: first tap arms the confirm, second tap fires it.
  const [confirmingClose, setConfirmingClose] = useState<number | null>(null);
  const [closingId, setClosingId] = useState<number | null>(null);

  async function closePosition(tradeId: number, symbol: string) {
    setClosingId(tradeId);
    try {
      const res = await fetch(`/api/trades/${tradeId}/close`, { method: "POST", credentials: "same-origin", headers: sectionHeaders() });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        const pnl = typeof data?.pnl === "number" ? data.pnl : null;
        toast({
          title: `${symbol} closed`,
          description: pnl != null ? `Realized P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "Position closed at market.",
        });
        queryClient.invalidateQueries({ queryKey: ["trades-monitor-active"] });
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTradesQueryKey() });
      } else {
        toast({ title: "Close failed", description: data?.error ?? "Could not close the position.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Close failed", description: "Couldn't reach the server.", variant: "destructive" });
    } finally {
      setClosingId(null);
      setConfirmingClose(null);
    }
  }

  // Distinguish "genuinely flat/idle" from "can't reach the API" — otherwise
  // a failed fetch renders identically to a real 0-position, 0-PnL bot.
  const statusUnknown = botLoading || botError;

  const isDemo = useIsDemo();
  const startBot = useStartBot();
  const stopBot = useStopBot();

  const handleStart = () => startBot.mutate(undefined, {
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      // Exclusive mode: the server reports when it stopped the sibling
      // section's engine — surface that so it never feels like a mystery.
      const note = (data as { note?: string } | undefined)?.note;
      if (note) toast({ title: "Engine started", description: note });
    },
    // A start can legitimately be refused — missing credentials, or a
    // deployment with no forex demo data source. Without this branch the
    // rejection was swallowed entirely: the button did nothing, the engine
    // stayed on STANDBY, and there was no way to find out why.
    onError: (err) => {
      const body = (err as { response?: { data?: { error?: string } } })?.response?.data;
      toast({
        variant: "destructive",
        title: "Engine did not start",
        description: body?.error ?? (err as Error)?.message ?? "The server refused the start request.",
      });
    },
  });
  const handleStop = () => stopBot.mutate(undefined, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() }) });

  return (
    <div className="max-w-6xl mx-auto space-y-4 sm:space-y-6">

      {/* First-run: section-aware guided setup (connect keys → risk → start).
          Supersedes the old Binance-only connect-keys prompt. */}
      <SetupChecklist />

      {/* Forex only: live market open/closed status with the next boundary. */}
      <ForexMarketBanner />

      {/* Hero Control Panel */}
      <CollapsibleSection
        id="engine"
        title="Trading Engine"
        icon={Power}
        right={
          <span className={cn(
            "text-[13px] font-mono font-bold",
            statusUnknown ? "text-muted-foreground" : bot?.running ? "text-success" : "text-destructive",
          )}>
            {statusUnknown ? "Unknown" : bot?.running ? "Running" : "Stopped"}
          </span>
        }
      >
      <div className="p-3 sm:p-4 grid grid-cols-1 md:grid-cols-4 gap-4 sm:gap-6">
        <Card className="md:col-span-2 relative overflow-hidden bg-card/50 border-primary/20 backdrop-blur">
          {/* Cactus AI's signature ambient glow — the hero card is the one
              place besides the header it's allowed to appear. */}
          <div className="ambient-glow" />
          <CardContent className="p-6 sm:p-8 flex flex-col justify-between h-full gap-6 relative z-10">
            <div>
              <h2 className="text-sm text-muted-foreground mb-1">Trading Engine</h2>
              <div className="flex items-center gap-3 mb-6">
                <span className={cn("relative flex h-3 w-3")}>
                  {bot?.running && !statusUnknown && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>}
                  <span className={cn("relative inline-flex rounded-full h-3 w-3", statusUnknown ? "bg-muted-foreground" : bot?.running ? "bg-success" : "bg-destructive")}></span>
                </span>
                <span className="text-xl sm:text-2xl font-bold tracking-tight">
                  {statusUnknown ? "Status unknown" : bot?.running ? "Engine running" : "Engine stopped"}
                </span>
              </div>
              {botError && (
                <div className="flex items-start gap-2 mb-4 text-[13px] font-mono text-destructive">
                  <WifiOff className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>Can't reach the API — this is NOT a confirmed idle state. Open positions may still exist.</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 sm:gap-4">
              <Button
                size="lg"
                className={cn("flex-1 sm:flex-none sm:w-40 font-mono tracking-wider font-bold transition-all", (bot?.running || isDemo) ? "opacity-50 cursor-not-allowed" : "bg-success text-success-foreground hover:bg-success/90")}
                onClick={handleStart}
                disabled={bot?.running || startBot.isPending || isDemo}
                title={isDemo ? "Disabled in the read-only demo" : undefined}
              >
                <Power className="mr-2 h-4 w-4" /> Start
              </Button>
              <Button
                size="lg"
                variant="destructive"
                className={cn("flex-1 sm:flex-none sm:w-40 font-mono tracking-wider font-bold transition-all", (!bot?.running || isDemo) ? "opacity-50 cursor-not-allowed" : "")}
                onClick={handleStop}
                disabled={!bot?.running || stopBot.isPending || isDemo}
                title={isDemo ? "Disabled in the read-only demo" : undefined}
              >
                <Square className="mr-2 h-4 w-4" /> Stop
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Quick Stats — 2-up on phones, 3-up from small screens, within the
            right half on desktop. Reuses <Stat> so type/padding scale down. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 sm:gap-6 md:col-span-2">
          <Stat
            label="Balance"
            valueClass={bot?.balanceUsdt == null ? "text-muted-foreground" : undefined}
            value={bot?.balanceUsdt == null ? "—" : formatCurrency(bot.balanceUsdt)}
            sub={bot?.balanceUsdt != null && (
              <p className="text-[13px] text-muted-foreground mt-1 truncate">
                {/* OANDA has no "testnet" — it's a practice account, and the
                    engine reports balances in USD (home currency converted). */}
                {section === "forex"
                  ? `USD · ${bot?.mode === "testnet" ? "practice" : bot?.mode}`
                  : `USDT · ${bot?.mode}`}
              </p>
            )}
          />
          <Stat
            label="Today's PnL"
            valueClass={statusUnknown ? "text-muted-foreground" : (bot?.dailyPnl ?? 0) >= 0 ? "text-success" : "text-destructive"}
            value={statusUnknown ? "—" : formatCurrency(bot?.dailyPnl, "always")}
          />
          {/* winRateToday is a 0–1 fraction; formatPercent expects 0–100.
              The engine reports a literal 0 when nothing has closed today
              (botEngine: `closedToday.length > 0 ? wins/n : 0`), so a null
              check is not enough — an account that has never traded would
              still read "0.00%", which is a measured-looking claim about a
              day with no measurements. Gate on the trade count instead: no
              trades closed today means there is no win rate today. */}
          <Stat
            label="Win Rate"
            valueClass={statusUnknown ? "text-muted-foreground" : "text-primary"}
            value={
              statusUnknown || !(bot?.totalTradesToday && bot.totalTradesToday > 0)
                ? "—"
                : formatPercent(bot.winRateToday * 100)
            }
          />
          <Stat
            label="Open Positions"
            valueClass={statusUnknown ? "text-muted-foreground" : undefined}
            value={statusUnknown ? "—" : (bot?.openPositions ?? 0)}
          />
          <Stat
            label="Total Trades"
            valueClass={statusUnknown ? "text-muted-foreground" : undefined}
            value={statusUnknown ? "—" : (bot?.totalTradesToday ?? 0)}
          />
        </div>
      </div>
      </CollapsibleSection>

      {/* Question 3 of 3: what does the engine want to do? Sits directly under
          the engine controls and above the positions, because a plan waiting
          on a decision is the most time-sensitive thing on this page. */}
      {!isDemo && <CopilotSummary />}

      {/* Question 2: what do I hold? */}
      <CollapsibleSection
        id="positions"
        title="Open Positions"
        icon={TrendingUp}
        right={
          <span className="text-[13px] font-mono text-muted-foreground">
            {positions?.length ?? 0} open
          </span>
        }
      >
        <PositionsPanel
          positions={positions}
          error={!!tradesError}
          loading={tradesLoading}
          confirmingClose={confirmingClose}
          closingId={closingId}
          onArmClose={setConfirmingClose}
          onClose={closePosition}
        />
      </CollapsibleSection>


      {/* Why is / isn't it trading — exact blocking condition. Hidden in the
          demo: there is no live scan loop, so "engine stopped / press START"
          would contradict the labeled DEMO snapshot above. */}
      {!isDemo && <BlockingBanner />}

      {/* Everything from here down is diagnostic rather than "what is happening
          right now", so it starts collapsed. The dashboard's job above the fold
          is three answers — is it running, what do I hold, what does it want to
          do — and eight equally-weighted panels answered none of them first.
          CollapsibleSection remembers each choice, so a user who opens one
          keeps it open. */}

      {/* Verification: live market data + full strategy decision pipeline.
          These are live-engine views (in-memory scan state), empty without a
          running engine — hidden in the demo, whose depth lives on the fully
          seeded Decision History, Trade Log, and Performance pages instead. */}
      {!isDemo && (
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6 items-start">
        <CollapsibleSection id="market-monitor" title="Market Monitor" icon={Activity} defaultOpen={false}>
          <div className="p-3"><MarketMonitor /></div>
        </CollapsibleSection>
        <CollapsibleSection id="decision-panel" title="Decision Pipeline" icon={Activity} defaultOpen={false}>
          <div className="p-3"><DecisionPanel /></div>
        </CollapsibleSection>
      </div>
      )}

      {/* Portfolio risk: which configured pairs are really the same bet. Unlike
          the two views above this reads daily history rather than in-memory
          scan state, so it is informative even with the engine stopped. */}
      {!isDemo && <CorrelationHeatMap />}

      {/* Scanner Table — live per-scan view, hidden in the demo (no engine). */}
      {!isDemo && (
      <CollapsibleSection
        id="scanner"
        title="Live Market Scanner"
        icon={Activity}
        defaultOpen={false}
        right={
          <span className="text-[13px] text-muted-foreground font-mono flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
            </span>
            Scanning {scanner?.length || 0} pairs
          </span>
        }
      >
          <div className="overflow-auto bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Symbol</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>RSI</TableHead>
                  <TableHead>ATR%</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scanner?.map((row) => (
                  <TableRow key={row.symbol} className={cn(
                    row.status === 'entered' && "bg-primary/5",
                    row.status === 'blacklisted' && "opacity-50"
                  )}>
                    <TableCell className="font-bold">{row.symbol}</TableCell>
                    <TableCell className="font-mono">{formatNumber(row.lastPrice, 4)}</TableCell>
                    <TableCell className="w-[120px]">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[13px] w-6">{row.confidence}</span>
                        <ProgressBar 
                          value={row.confidence} 
                          colorClass={row.confidence > 80 ? "bg-success" : row.confidence > 65 ? "bg-warning" : "bg-destructive"} 
                        />
                      </div>
                    </TableCell>
                    <TableCell className="font-mono">
                      <span className={cn(
                        row.rsi > 70 ? "text-destructive" : row.rsi < 30 ? "text-success" : "text-muted-foreground"
                      )}>{formatNumber(row.rsi, 1)}</span>
                    </TableCell>
                    <TableCell className="font-mono">{formatNumber(row.atrPercent, 2)}%</TableCell>
                    <TableCell>
                      <Badge variant={
                        row.status === 'entered' ? 'default' : 
                        row.status === 'blacklisted' ? 'destructive' : 
                        row.status === 'watching' ? 'outline' : 'secondary'
                      }>
                        {row.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {scannerError && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-destructive font-mono text-sm">
                      Unable to load scanner data — check API connectivity.
                    </TableCell>
                  </TableRow>
                )}
                {!scannerError && scannerLoading && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground font-mono text-sm">
                      Loading scanner data…
                    </TableCell>
                  </TableRow>
                )}
                {!scannerError && !scannerLoading && (!scanner || scanner.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground font-mono text-sm">
                      No pairs matching scan criteria.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
      </CollapsibleSection>
      )}
    </div>
  );
}

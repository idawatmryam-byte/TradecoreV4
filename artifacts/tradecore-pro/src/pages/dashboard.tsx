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
import { SignalFunnel } from "@/components/signal-funnel";
import { BrainStatusStrip } from "@/components/brain-status";
import { MarketOverview } from "@/components/market-overview";

/** Live per-position feed from GET /trades/monitor/active â€” entry vs current
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
 * Minimizable cockpit panel. Every dashboard section wraps in one of these â€”
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

/** The Open Positions panel body â€” full trade status per open position plus
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
                      {p.side}{p.marketType === "futures" && p.leverage ? ` ${p.leverage}Ã—` : ""}
                    </Badge>
                    {p.breakEvenActive && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">BE</Badge>}
                    {p.trailingStopActive && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">TRAIL</Badge>}
                    {p.tp1Filled && <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-success">TP1 âœ“</Badge>}
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
                    {p.strategyName} Â· held {formatHeld(p.holdingSeconds)}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 text-[13px] font-mono text-muted-foreground">
                  <div>
                    <span className="block opacity-50 mb-0.5">Entry â†’ Now</span>
                    <span className="text-foreground">
                      {formatNumber(p.entryPrice, 4)} â†’ {formatNumber(p.currentPrice, 4)}
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
                    Tap for live chart Â· entry / SL / TP levels
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
          <p className="text-[13px] text-muted-foreground mt-1 normal-case">Open positions may still exist â€” check the exchange directly.</p>
        </div>
      )}
      {!error && loading && (
        <div className="p-8 text-center text-muted-foreground">
          <p className="text-sm">Loading positionsâ€¦</p>
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
 * account resolves to DEMO â€” the engine creates every new section with
 * executionTarget "demo" and mode "copilot" (botEngine.loadConfig). So:
 *
 *   DEMO  no keys, no exchange, no funds. Start the engine and, in Co-Pilot,
 *         approve the first recommendation. Connecting a broker is offered as
 *         a later, deliberate step rather than the price of entry.
 *   LIVE  the original path: connect the section's broker keys â†’ review the
 *         risk plan â†’ press Start.
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
  // Forex demo needs the platform's own OANDA practice token â€” OANDA
  // publishes no public market data, so a keyless forex demo is impossible
  // rather than merely unconfigured. When it is missing, promising "no broker
  // needed" and then refusing to start is the worst of both worlds.
  const demoBlocked = demoTarget && config?.demoDataAvailable === false;

  // Credential queries are pointless in demo â€” skip the requests entirely
  // rather than fetching and ignoring them.
  const binance = useGetBinanceCredentials({
    query: { queryKey: getGetBinanceCredentialsQueryKey(), enabled: !forex && !demoTarget },
  });
  const oanda = useGetOandaCredentials({
    query: { queryKey: getGetOandaCredentialsQueryKey(), enabled: forex && !demoTarget },
  });
  const { data: bot } = useGetBotStatus({ query: { queryKeyç®»¶‰ËkºwµçH°4(€€€€€ô¤ì4(€€€ô°4(€ô¤ì4(€½¹ÍĞ¡…¹‘±•MÑ½À€ô€ ¤€ôøÍÑ½Á	½Ğ¹µÕÑ…Ñ”¡Õ¹‘•™¥¹•°ì½¹MÕ•ÍÌè€ ¤€ôøÅÕ•Éå±¥•¹Ğ¹¥¹Ù…±¥‘…Ñ•EÕ•É¥•Ì¡ìÅÕ•Éå-•äè•Ñ•Ñ	½ÑMÑ…ÑÕÍEÕ•Éå-•ä ¤ô¤ô¤ì4(4(€É•ÑÕÉ¸€ 4(€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰µ…àµÜ´Ùá°µàµ…ÕÑ¼ÍÁ…”µä´ĞÍ´éÍÁ…”µä´Øˆø4(4(€€€€€€ñ	É…¥¹MÑ…ÑÕÍMÑÉ¥À€¼ø4(4(€€€€€€ñ5…É­•Ñ=Ù•ÉÙ¥•Ü€¼ø4(4(€€€€€ì¼¨¥ÉÍĞµÉÕ¸èÍ•Ñ¥½¸µ…İ…É”Õ¥‘•Í•ÑÕÀ€¡½¹¹•Ğ­•åÌƒŠHÉ¥Í¬ƒŠHÍÑ…ÉĞ¤¸4(€€€€€€€€€MÕÁ•ÉÍ•‘•ÌÑ¡”½±	¥¹…¹”µ½¹±ä½¹¹•Ğµ­•åÌÁÉ½µÁĞ¸€¨½ô4(€€€€€€ñM•ÑÕÁ¡•­±¥ÍĞ€¼ø4(4(€€€€€ì¼¨½É•à½¹±äè±¥Ù”µ…É­•Ğ½Á•¸½±½Í•ÍÑ…ÑÕÌİ¥Ñ Ñ¡”¹•áĞ‰½Õ¹‘…Éä¸€¨½ô4(€€€€€€ñ½É•á5…É­•Ñ	…¹¹•È€¼ø4(4(€€€€€ì¼¨!•É¼½¹ÑÉ½°A…¹•°€¨½ô4(€€€€€€ñ½±±…ÁÍ¥‰±•M•Ñ¥½¸4(€€€€€€€¥ô‰•¹¥¹”ˆ4(€€€€€€€Ñ¥Ñ±”ô‰QÉ…‘¥¹œ¹¥¹”ˆ4(€€€€€€€¥½¸õíA½İ•Éô4(€€€€€€€É¥¡Ğõì4(€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”õí¸ 4(€€€€€€€€€€€€‰Ñ•áĞµlÄÍÁát™½¹Ğµµ½¹¼™½¹Ğµ‰½±ˆ°4(€€€€€€€€€€€ÍÑ…ÑÕÍU¹­¹½İ¸€ü€‰Ñ•áĞµµÕÑ•µ™½É•É½Õ¹ˆ€è‰½Ğü¹ÉÕ¹¹¥¹œ€ü€‰Ñ•áĞµÍÕ•ÍÌˆ€è€‰Ñ•áĞµ‘•ÍÑÉÕÑ¥Ù”ˆ°4(€€€€€€€€€€¥ôø4(€€€€€€€€€€€íÍÑ…ÑÕÍU¹­¹½İ¸€ü€‰U¹­¹½İ¸ˆ€è‰½Ğü¹ÉÕ¹¹¥¹œ€ü€‰IÕ¹¹¥¹œˆ€è€‰MÑ½ÁÁ•‰ô4(€€€€€€€€€€ğ½ÍÁ…¸ø4(€€€€€€€ô4(€€€€€€ø4(€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰À´ÌÍ´éÀ´ĞÉ¥É¥µ½±Ì´ÄµéÉ¥µ½±Ì´Ğ…À´ĞÍ´é…À´Øˆø4(€€€€€€€ì¼¨Q¡”‰…±…¹”¥ÌÑ¡”Ñ¡¥¹œ„Á•ÉÍ½¸½Á•¹ÌÑ¡¥ÌÁ…”Ñ¼Í•”°Í¼¥Ğ¥Ì4(€€€€€€€€€€€Ñ¡”±…É•ÍĞÑ¡¥¹œ½¸¥Ğ¸¹¥¹”ÍÑ…Ñ”‘•µ½Ñ•ÌÑ¼„Á¥±°è¥Ğ¥Ì„4(€€€€€€€€€€€™…Ğå½Ô¡•¬°¹½ĞÑ¡”¡•…‘±¥¹”¸Q½‘…äÌµ½Ù”É¥‘•Ì‘¥É•Ñ±äÕ¹‘•È4(€€€€€€€€€€€Ñ¡”¹Õµ‰•È…Ì„‘•±Ñ„°‰•…ÕÍ”„‰…±…¹”İ¥Ñ¡½ÕĞ¥ÑÌ‘¥É•Ñ¥½¸¥Ì4(€€€€€€€€€€€¡…±˜…¸…¹Íİ•È¸€¨½ô4(€€€€€€€€ñ…É±…ÍÍ9…µ”ô‰µé½°µÍÁ…¸´ÈÉ•±…Ñ¥Ù”½Ù•É™±½Üµ¡¥‘‘•¸ˆø4(€€€€€€€€€ì¼¨…ÑÕÌ$ÌÍ¥¹…ÑÕÉ”…µ‰¥•¹Ğ±½ÜƒŠPÑ¡”¡•É¼…É¥ÌÑ¡”½¹”4(€€€€€€€€€€€€€Á±…”‰•Í¥‘•ÌÑ¡”¡•…‘•È¥ĞÌ…±±½İ•Ñ¼…ÁÁ•…È¸€¨½ô4(€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…µ‰¥•¹Ğµ±½Üˆ€¼ø4(€€€€€€€€€€ñ…É‘½¹Ñ•¹Ğ±…ÍÍ9…µ”ô‰É•±…Ñ¥Ù”è´ÄÀ™±•à µ™Õ±°™±•àµ½°©ÕÍÑ¥™äµ‰•Ñİ••¸…À´ÜÀ´ØÍ´éÀ´àˆø4(€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµÍÑ…ÉĞ…À´Ğˆø4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰µ¥¸µÜ´Àˆø4(€€€€€€€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áĞµlÄÀ¸ÕÁát™½¹Ğµ‰½±ÕÁÁ•É…Í”ÑÉ…­¥¹œµlÀ¸ÄÉ•µtÑ•áĞµµÕÑ•µ™½É•É½Õ¹ˆø4(€€€€€€€€€€€€€€€€€	…±…¹”4(€€€€€€€€€€€€€€€€ğ½Àø4(€€€€€€€€€€€€€€€€ñÀ±…ÍÍ9…µ”õí¸ 4(€€€€€€€€€€€€€€€€€€‰¹Õµ•É¥ŒµĞ´ÌÑÉÕ¹…Ñ”Ñ•áĞµlÌÑÁát™½¹ĞµÍ•µ¥‰½±±•…‘¥¹œµ¹½¹”Í´éÑ•áĞµlĞÉÁátˆ°4(€€€€€€€€€€€€€€€€€‰½Ğü¹‰…±…¹•UÍ‘Ğ€ôô¹Õ±°€˜˜€‰Ñ•áĞµµÕÑ•µ™½É•É½Õ¹ˆ°4(€€€€€€€€€€€€€€€€¥ôø4(€€€€€€€€€€€€€€€€€í‰½Ğü¹‰…±…¹•UÍ‘Ğ€ôô¹Õ±°€ü€‹ŠPˆ€è™½Éµ…ÑÕÉÉ•¹ä¡‰½Ğ¹‰…±…¹•UÍ‘Ğ¥ô4(€€€€€€€€€€€€€€€€ğ½Àø4(4(€€€€€€€€€€€€€€€ì¼¨9•Ù•ÈÉ•¹‘•É•…Ì„é•É¼İ¡•¸Ñ¡”ÍÑ…Ñ”¥ÌÕ¹­¹½İ¸ƒŠP…¸4(€€€€€€€€€€€€€€€€€€€Õ¹É•…¡…‰±”A$¥Ì¹½Ğ„™±…Ğ‘…ä¸€¨½ô4(€€€€€€€€€€€€€€€ì…ÍÑ…ÑÕÍU¹­¹½İ¸€˜˜‰½Ğü¹‘…¥±åA¹°€„ô¹Õ±°€ü€ 4(€€€€€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”õí¸ 4(€€€€€€€€€€€€€€€€€€€€‰¹Õµ•É¥ŒµĞ´Ğ¥¹±¥¹”µ™±•à¥Ñ•µÌµ•¹Ñ•È…À´Ä¸ÔÉ½Õ¹‘•µ™Õ±°Áà´ÌÁä´Ä¸ÔÑ•áĞµlÄÍÁát™½¹ĞµÍ•µ¥‰½±ˆ°4(€€€€€€€€€€€€€€€€€€€‰½Ğ¹‘…¥±åA¹°€øô€À€ü€‰‰œµÍÕ•ÍÌ¼ÄÈÑ•áĞµÍÕ•ÍÌˆ€è€‰‰œµ‘•ÍÑÉÕÑ¥Ù”¼ÄÈÑ•áĞµ‘•ÍÑÉÕÑ¥Ù”ˆ°4(€€€€€€€€€€€€€€€€€€¥ôø4(€€€€€€€€€€€€€€€€€€€í‰½Ğ¹‘…¥±åA¹°€øô€À4(€€€€€€€€€€€€€€€€€€€€€€ü€ñÉÉ½İUÁI¥¡Ğ±…ÍÍ9…µ”ô‰ ´Ì¸ÔÜ´Ì¸ÔÍ¡É¥¹¬´Àˆ€¼ø4(€€€€€€€€€€€€€€€€€€€€€€è€ñÉÉ½İ½İ¹I¥¡Ğ±…ÍÍ9…µ”ô‰ ´Ì¸ÔÜ´Ì¸ÔÍ¡É¥¹¬´Àˆ€¼ùô4(€€€€€€€€€€€€€€€€€€€í™½Éµ…ÑÕÉÉ•¹ä¡‰½Ğ¹‘…¥±åA¹°°€‰…±İ…åÌˆ¥ôÑ½‘…ä4(€€€€€€€€€€€€€€€€€€ğ½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€¤€è€ 4(€€€€€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰µĞ´Ğ¥¹±¥¹”µ‰±½¬Ñ•áĞµlÄÍÁátÑ•áĞµµÕÑ•µ™½É•É½Õ¹ˆø4(€€€€€€€€€€€€€€€€€€€9¼µ½Ù•µ•¹ĞÉ•½É‘•Ñ½‘…ä4(€€€€€€€€€€€€€€€€€€ğ½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€¥ô4(4(€€€€€€€€€€€€€€€í‰½Ğü¹‰…±…¹•UÍ‘Ğ€„ô¹Õ±°€˜˜€ 4(€€€€€€€€€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰µĞ´ÌÑÉÕ¹…Ñ”Ñ•áĞµlÄÍÁátÑ•áĞµµÕÑ•µ™½É•É½Õ¹ˆø4(€€€€€€€€€€€€€€€€€€€ì¼¨=9¡…Ì¹¼€‰Ñ•ÍÑ¹•ĞˆƒŠP¥ĞÌ„ÁÉ…Ñ¥”…½Õ¹Ğ°…¹Ñ¡”4(€€€€€€€€€€€€€€€€€€€€€€€•¹¥¹”É•Á½ÉÑÌ‰…±…¹•Ì¥¸UM€¡¡½µ”ÕÉÉ•¹ä½¹Ù•ÉÑ•¤¸€¨½ô4(€€€€€€€€€€€€€€€€€€€íÍ•Ñ¥½¸€ôôô€‰™½É•àˆ4(€€€€€€€€€€€€€€€€€€€€€€üUMƒ
Ü€‘í‰½Ğü¹µ½‘”€ôôô€‰Ñ•ÍÑ¹•Ğˆ€ü€‰ÁÉ…Ñ¥”ˆ€è‰½Ğü¹µ½‘•õ€4(€€€€€€€€€€€€€€€€€€€€€€èUMPƒ
Ü€‘í‰½Ğü¹µ½‘•õô4(€€€€€€€€€€€€€€€€€€ğ½Àø4(€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€ğ½‘¥Øø4(4(€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”õí¸ 4(€€€€€€€€€€€€€€€€‰µ°µ…ÕÑ¼™±•àÍ¡É¥¹¬´À¥Ñ•µÌµ•¹Ñ•È…À´ÈÉ½Õ¹‘•µ™Õ±°Áà´Ì¸ÔÁä´ÈÑ•áĞµlÄÍÁát™½¹ĞµÍ•µ¥‰½±ˆ°4(€€€€€€€€€€€€€€€ÍÑ…ÑÕÍU¹­¹½İ¸€ü€‰‰œµµÕÑ•Ñ•áĞµµÕÑ•µ™½É•É½Õ¹ˆ4(€€€€€€€€€€€€€€€€€€è‰½Ğü¹ÉÕ¹¹¥¹œ€ü€‰‰œµÍÕ•ÍÌ¼ÄÈÑ•áĞµÍÕ•ÍÌˆ4(€€€€€€€€€€€€€€€€€€è€‰‰œµµÕÑ•Ñ•áĞµµÕÑ•µ™½É•É½Õ¹ˆ°4(€€€€€€€€€€€€€€¥ôø4(€€€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰É•±…Ñ¥Ù”™±•à ´ÈÜ´Èˆø4(€€€€€€€€€€€€€€€€€í‰½Ğü¹ÉÕ¹¹¥¹œ€˜˜€…ÍÑ…ÑÕÍU¹­¹½İ¸€˜˜€ 4(€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰…‰Í½±ÕÑ”¥¹±¥¹”µ™±•à µ™Õ±°Üµ™Õ±°…¹¥µ…Ñ”µÁ¥¹œÉ½Õ¹‘•µ™Õ±°‰œµÍÕ•ÍÌ½Á…¥Ñä´ÜÔˆ€¼ø4(€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”õí¸ 4(€€€€€€€€€€€€€€€€€€€€‰É•±…Ñ¥Ù”¥¹±¥¹”µ™±•à ´ÈÜ´ÈÉ½Õ¹‘•µ™Õ±°ˆ°4(€€€€€€€€€€€€€€€€€€€ÍÑ…ÑÕÍU¹­¹½İ¸€ü€‰‰œµµÕÑ•µ™½É•É½Õ¹ˆ€è‰½Ğü¹ÉÕ¹¹¥¹œ€ü€‰‰œµÍÕ•ÍÌˆ€è€‰‰œµ‘•ÍÑÉÕÑ¥Ù”ˆ°4(€€€€€€€€€€€€€€€€€€¥ô€¼ø4(€€€€€€€€€€€€€€€€ğ½ÍÁ…¸ø4(€€€€€€€€€€€€€€€íÍÑ…ÑÕÍU¹­¹½İ¸€ü€‰U¹­¹½İ¸ˆ€è‰½Ğü¹ÉÕ¹¹¥¹œ€ü€‰IÕ¹¹¥¹œˆ€è€‰MÑ½ÁÁ•‰ô4(€€€€€€€€€€€€€€ğ½ÍÁ…¸ø4(€€€€€€€€€€€€ğ½‘¥Øø4(4(€€€€€€€€€€€í‰½ÑÉÉ½È€˜˜€ 4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµÍÑ…ÉĞ…À´ÈÑ•áĞµlÄÍÁátÑ•áĞµ‘•ÍÑÉÕÑ¥Ù”ˆø4(€€€€€€€€€€€€€€€€ñ]¥™¥=™˜±…ÍÍ9…µ”ô‰µĞ´À¸Ô ´Ì¸ÔÜ´Ì¸ÔÍ¡É¥¹¬´Àˆ€¼ø4(€€€€€€€€€€€€€€€€ñÍÁ…¸ù…¸ĞÉ•… Ñ¡”A$ƒŠPÑ¡¥Ì¥Ì9=P„½¹™¥Éµ•¥‘±”ÍÑ…Ñ”¸=Á•¸Á½Í¥Ñ¥½¹Ìµ…äÍÑ¥±°•á¥ÍĞ¸ğ½ÍÁ…¸ø4(€€€€€€€€€€€€€€ğ½‘¥Øø4(€€€€€€€€€€€€¥ô4(4(€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È…À´Ìˆø4(€€€€€€€€€€€€€€ñ	ÕÑÑ½¸4(€€€€€€€€€€€€€€€Í¥é”ô‰±œˆ4(€€€€€€€€€€€€€€€±…ÍÍ9…µ”õí¸ ‰™±•à´ÄÍ´é™±•àµ¹½¹”Í´éÜ´ÌØˆ°€¡‰½Ğü¹ÉÕ¹¹¥¹œñğ¥Í•µ¼¤€ü€‰½Á…¥Ñä´ÔÀÕÉÍ½Èµ¹½Ğµ…±±½İ•ˆ€è€‰‰œµÍÕ•ÍÌÑ•áĞµÍÕ•ÍÌµ™½É•É½Õ¹¡½Ù•Èé‰œµÍÕ•ÍÌ¼äÀˆ¥ô4(€€€€€€€€€€€€€€€½¹±¥¬õí¡…¹‘±•MÑ…ÉÑô4(€€€€€€€€€€€€€€€‘¥Í…‰±•õí‰½Ğü¹ÉÕ¹¹¥¹œñğÍÑ…ÉÑ	½Ğ¹¥ÍA•¹‘¥¹œñğ¥Í•µ½ô4(€€€€€€€€€€€€€€€Ñ¥Ñ±”õí¥Í•µ¼€ü€‰¥Í…‰±•¥¸Ñ¡”É•…µ½¹±ä‘•µ¼ˆ€èÕ¹‘•™¥¹•‘ô4(€€€€€€€€€€€€€€ø4(€€€€€€€€€€€€€€€€ñA½İ•È±…ÍÍ9…µ”ô‰µÈ´È ´ĞÜ´Ğˆ€¼øMÑ…ÉĞ4(€€€€€€€€€€€€€€ğ½	ÕÑÑ½¸ø4(€€€€€€€€€€€€€€ñ	ÕÑÑ½¸4(€€€€€€€€€€€€€€€Í¥é”ô‰±œˆ4(€€€€€€€€€€€€€€€Ù…É¥…¹Ğô‰½ÕÑ±¥¹”ˆ4(€€€€€€€€€€€€€€€±…ÍÍ9…µ”õí¸ ‰™±•à´ÄÍ´é™±•àµ¹½¹”Í´éÜ´ÌØˆ°€ …‰½Ğü¹ÉÕ¹¹¥¹œñğ¥Í•µ¼¤€˜˜€‰½Á…¥Ñä´ÔÀÕÉÍ½Èµ¹½Ğµ…±±½İ•ˆ¥ô4(€€€€€€€€€€€€€€€½¹±¥¬õí¡…¹‘±•MÑ½Áô4(€€€€€€€€€€€€€€€‘¥Í…‰±•õì…‰½Ğü¹ÉÕ¹¹¥¹œñğÍÑ½Á	½Ğ¹¥ÍA•¹‘¥¹œñğ¥Í•µ½ô4(€€€€€€€€€€€€€€€Ñ¥Ñ±”õí¥Í•µ¼€ü€‰¥Í…‰±•¥¸Ñ¡”É•…µ½¹±ä‘•µ¼ˆ€èÕ¹‘•™¥¹•‘ô4(€€€€€€€€€€€€€€ø4(€€€€€€€€€€€€€€€€ñMÅÕ…É”±…ÍÍ9…µ”ô‰µÈ´È ´ĞÜ´Ğˆ€¼øMÑ½À4(€€€€€€€€€€€€€€ğ½	ÕÑÑ½¸ø4(€€€€€€€€€€€€ğ½‘¥Øø4(€€€€€€€€€€ğ½…É‘½¹Ñ•¹Ğø4(€€€€€€€€ğ½…Éø4(4(€€€€€€€ì¼¨EÕ¥¬MÑ…ÑÌƒŠP€ÈµÕÀ½¸Á¡½¹•Ì°€ÌµÕÀ™É½´Íµ…±°ÍÉ••¹Ì°İ¥Ñ¡¥¸Ñ¡”4(€€€€€€€€€€€É¥¡Ğ¡…±˜½¸‘•Í­Ñ½À¸I•ÕÍ•Ì€ñMÑ…ĞøÍ¼ÑåÁ”½Á…‘‘¥¹œÍ…±”‘½İ¸¸€¨½ô4(€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰É¥É¥µ½±Ì´ÈÍ´éÉ¥µ½±Ì´Ì…À´ĞÍ´é…À´Øµé½°µÍÁ…¸´Èˆø4(€€€€€€€€€€ñMÑ…Ğ4(€€€€€€€€€€€±…‰•°ô‰]¥¸I…Ñ”ˆ4(€€€€€€€€€€€Ù…±Õ•±…ÍÌõíÍÑ…ÑÕÍU¹­¹½İ¸€ü€‰Ñ•áĞµµÕÑ•µ™½É•É½Õ¹ˆ€è€‰Ñ•áĞµÁÉ¥µ…Éä‰ô4(€€€€€€€€€€€Ù…±Õ”õì4(€€€€€€€€€€€€€ÍÑ…ÑÕÍU¹­¹½İ¸ñğ€„¡‰½Ğü¹Ñ½Ñ…±QÉ…‘•ÍQ½‘…ä€˜˜‰½Ğ¹Ñ½Ñ…±QÉ…‘•ÍQ½‘…ä€ø€À¤4(€€€€€€€€€€€€€€€€ü€‹ŠPˆ4(€€€€€€€€€€€€€€€€è™½Éµ…ÑA•É•¹Ğ¡‰½Ğ¹İ¥¹I…Ñ•Q½‘…ä€¨€ÄÀÀ¤4(€€€€€€€€€€€ô4(€€€€€€€€€€¼ø4(€€€€€€€€€€ñMÑ…Ğ4(€€€€€€€€€€€±…‰•°ô‰=Á•¸A½Í¥Ñ¥½¹Ìˆ4(€€€€€€€€€€€Ù…±Õ•±…ÍÌõíÍÑ…ÑÕÍU¹­¹½İ¸€ü€‰Ñ•áĞµµÕÑ•µ™½É•É½Õ¹ˆ€èÕ¹‘•™¥¹•‘ô4(€€€€€€€€€€€Ù…±Õ”õíÍÑ…ÑÕÍU¹­¹½İ¸€ü€‹ŠPˆ€è€¡‰½Ğü¹½Á•¹A½Í¥Ñ¥½¹Ì€üü€À¥ô4(€€€€€€€€€€¼ø4(€€€€€€€€€€ñMÑ…Ğ4(€€€€€€€€€€€±…‰•°ô‰Q½Ñ…°QÉ…‘•Ìˆ4(€€€€€€€€€€€Ù…±Õ•±…ÍÌõíÍÑ…ÑÕÍU¹­¹½İ¸€ü€‰Ñ•áĞµµÕÑ•µ™½É•É½Õ¹ˆ€èÕ¹‘•™¥¹•‘ô4(€€€€€€€€€€€Ù…±Õ”õíÍÑ…ÑÕÍU¹­¹½İ¸€ü€‹ŠPˆ€è€¡‰½Ğü¹Ñ½Ñ…±QÉ…‘•ÍQ½‘…ä€üü€À¥ô4(€€€€€€€€€€¼ø4(€€€€€€€€ğ½‘¥Øø4(€€€€€€ğ½‘¥Øø4(€€€€€€ğ½½±±…ÁÍ¥‰±•M•Ñ¥½¸ø4(4(€€€€€ì¼¨%ÌÑ¡”•¹¥¹”½¹Ù•ÉÑ¥¹œİ¡…Ğ¥Ğ™¥¹‘ÌüM¥ÑÌ‘¥É•Ñ±äÕ¹‘•ÈÑ¡”4(€€€€€€€€€½¹ÑÉ½±Ì‰•…ÕÍ”€‰¥ĞÌÉÕ¹¹¥¹œˆ…¹€‰¥ĞÌÁÉ½‘Õ¥¹œ¹½Ñ¡¥¹œˆ…É”Ñİ¼4(€€€€€€€€€‘¥™™•É•¹ĞÍÑ…Ñ•ÌÑ¡…Ğ±½½­•¥‘•¹Ñ¥…°¡•É”™½ÈÑİ¼‘…åÌ¸I•¹‘•ÉÌ4(€€€€€€€€€¹½Ñ¡¥¹œÕ¹Ñ¥°Ñ¡•É”…É”‘•¥Í¥½¹ÌÑ¼ÍÕµµ…É¥Í”¸€¨½ô4(€€€€€ì…¥Í•µ¼€˜˜€ñM¥¹…±Õ¹¹•°€¼ùô4(4(€€€€€ì¼¨EÕ•ÍÑ¥½¸€Ì½˜€Ìèİ¡…Ğ‘½•ÌÑ¡”•¹¥¹”İ…¹ĞÑ¼‘¼üM¥ÑÌ‘¥É•Ñ±äÕ¹‘•È4(€€€€€€€€€Ñ¡”•¹¥¹”½¹ÑÉ½±Ì…¹…‰½Ù”Ñ¡”Á½Í¥Ñ¥½¹Ì°‰•…ÕÍ”„Á±…¸İ…¥Ñ¥¹œ4(€€€€€€€€€½¸„‘•¥Í¥½¸¥ÌÑ¡”µ½ÍĞÑ¥µ”µÍ•¹Í¥Ñ¥Ù”Ñ¡¥¹œ½¸Ñ¡¥ÌÁ…”¸€¨½ô4(€€€€€ì…¥Í•µ¼€˜˜€ñ½Á¥±½ÑMÕµµ…Éä€¼ùô4(4(€€€€€ì¼¨EÕ•ÍÑ¥½¸€Èèİ¡…Ğ‘¼$¡½±ü€¨½ô4(€€€€€€ñ½±±…ÁÍ¥‰±•M•Ñ¥½¸4(€€€€€€€¥ô‰Á½Í¥Ñ¥½¹Ìˆ4(€€€€€€€Ñ¥Ñ±”ô‰=Á•¸A½Í¥Ñ¥½¹Ìˆ4(€€€€€€€¥½¸õíQÉ•¹‘¥¹UÁô4(€€€€€€€É¥¡Ğõì4(€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰Ñ•áĞµlÄÍÁát™½¹Ğµµ½¹¼Ñ•áĞµµÕÑ•µ™½É•É½Õ¹ˆø4(€€€€€€€€€€€íÁ½Í¥Ñ¥½¹Ìü¹±•¹Ñ €üü€Áô½Á•¸4(€€€€€€€€€€ğ½ÍÁ…¸ø4(€€€€€€€ô4(€€€€€€ø4(€€€€€€€€ñA½Í¥Ñ¥½¹ÍA…¹•°4(€€€€€€€€€Á½Í¥Ñ¥½¹ÌõíÁ½Í¥Ñ¥½¹Íô4(€€€€€€€€€•ÉÉ½Èõì„…ÑÉ…‘•ÍÉÉ½Éô4(€€€€€€€€€±½…‘¥¹œõíÑÉ…‘•Í1½…‘¥¹ô4(€€€€€€€€€½¹™¥Éµ¥¹±½Í”õí½¹™¥Éµ¥¹±½Í•ô4(€€€€€€€€€±½Í¥¹%õí±½Í¥¹%‘ô4(€€€€€€€€€½¹Éµ±½Í”õíÍ•Ñ½¹™¥Éµ¥¹±½Í•ô4(€€€€€€€€€½¹±½Í”õí±½Í•A½Í¥Ñ¥½¹ô4(€€€€€€€€¼ø4(€€€€€€ğ½½±±…ÁÍ¥‰±•M•Ñ¥½¸ø4(4(4(€€€€€ì¼¨]¡ä¥Ì€¼¥Í¸Ğ¥ĞÑÉ…‘¥¹œƒŠP•á…Ğ‰±½­¥¹œ½¹‘¥Ñ¥½¸¸!¥‘‘•¸¥¸Ñ¡”4(€€€€€€€€€‘•µ¼èÑ¡•É”¥Ì¹¼±¥Ù”Í…¸±½½À°Í¼€‰•¹¥¹”ÍÑ½ÁÁ•€¼ÁÉ•ÍÌMQIPˆ4(€€€€€€€€€İ½Õ±½¹ÑÉ…‘¥ĞÑ¡”±…‰•±•5<Í¹…ÁÍ¡½Ğ…‰½Ù”¸€¨½ô4(€€€€€ì…¥Í•µ¼€˜˜€ñ	±½­¥¹	…¹¹•È€¼ùô4(4(€€€€€ì¼¨Ù•ÉåÑ¡¥¹œ™É½´¡•É”‘½İ¸¥Ì‘¥…¹½ÍÑ¥ŒÉ…Ñ¡•ÈÑ¡…¸€‰İ¡…Ğ¥Ì¡…ÁÁ•¹¥¹œ4(€€€€€€€€€É¥¡Ğ¹½Üˆ°Í¼¥ĞÍÑ…ÉÑÌ½±±…ÁÍ•¸Q¡”‘…Í¡‰½…ÉÌ©½ˆ…‰½Ù”Ñ¡”™½±4(€€€€€€€€€¥ÌÑ¡É•”…¹Íİ•ÉÌƒŠP¥Ì¥ĞÉÕ¹¹¥¹œ°İ¡…Ğ‘¼$¡½±°İ¡…Ğ‘½•Ì¥Ğİ…¹ĞÑ¼4(€€€€€€€€€‘¼ƒŠP…¹•¥¡Ğ•ÅÕ…±±äµİ•¥¡Ñ•Á…¹•±Ì…¹Íİ•É•¹½¹”½˜Ñ¡•´™¥ÉÍĞ¸4(€€€€€€€€€½±±…ÁÍ¥‰±•M•Ñ¥½¸É•µ•µ‰•ÉÌ•… ¡½¥”°Í¼„ÕÍ•Èİ¡¼½Á•¹Ì½¹”4(€€€€€€€€€­••ÁÌ¥Ğ½Á•¸¸€¨½ô4(4(€€€€€ì¼¨Y•É¥™¥…Ñ¥½¸è±¥Ù”µ…É­•Ğ‘…Ñ„€¬™Õ±°ÍÑÉ…Ñ•ä‘•¥Í¥½¸Á¥Á•±¥¹”¸4(€€€€€€€€€Q¡•Í”…É”±¥Ù”µ•¹¥¹”Ù¥•İÌ€¡¥¸µµ•µ½ÉäÍ…¸ÍÑ…Ñ”¤°•µÁÑäİ¥Ñ¡½ÕĞ„4(€€€€€€€€€ÉÕ¹¹¥¹œ•¹¥¹”ƒŠP¡¥‘‘•¸¥¸Ñ¡”‘•µ¼°İ¡½Í”‘•ÁÑ ±¥Ù•Ì½¸Ñ¡”™Õ±±ä4(€€€€€€€€€Í••‘••¥Í¥½¸!¥ÍÑ½Éä°QÉ…‘”1½œ°…¹A•É™½Éµ…¹”Á…•Ì¥¹ÍÑ•…¸€¨½ô4(€€€€€ì…¥Í•µ¼€˜˜€ 4(€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰É¥É¥µ½±Ì´Äá°éÉ¥µ½±Ì´È…À´ĞÍ´é…À´Ø¥Ñ•µÌµÍÑ…ÉĞˆø4(€€€€€€€€ñ½±±…ÁÍ¥‰±•M•Ñ¥½¸¥ô‰µ…É­•Ğµµ½¹¥Ñ½ÈˆÑ¥Ñ±”ô‰5…É­•Ğ5½¹¥Ñ½Èˆ¥½¸õíÑ¥Ù¥Ñåô‘•™…Õ±Ñ=Á•¸õí™…±Í•ôø4(€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰À´Ìˆøñ5…É­•Ñ5½¹¥Ñ½È€¼øğ½‘¥Øø4(€€€€€€€€ğ½½±±…ÁÍ¥‰±•M•Ñ¥½¸ø4(€€€€€€€€ñ½±±…ÁÍ¥‰±•M•Ñ¥½¸¥ô‰‘•¥Í¥½¸µÁ…¹•°ˆÑ¥Ñ±”ô‰•¥Í¥½¸A¥Á•±¥¹”ˆ¥½¸õíÑ¥Ù¥Ñåô‘•™…Õ±Ñ=Á•¸õí™…±Í•ôø4(€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰À´Ìˆøñ•¥Í¥½¹A…¹•°€¼øğ½‘¥Øø4(€€€€€€€€ğ½½±±…ÁÍ¥‰±•M•Ñ¥½¸ø4(€€€€€€ğ½‘¥Øø4(€€€€€€¥ô4(4(€€€€€ì¼¨A½ÉÑ™½±¥¼É¥Í¬èİ¡¥ ½¹™¥ÕÉ•Á…¥ÉÌ…É”É•…±±äÑ¡”Í…µ”‰•Ğ¸U¹±¥­”4(€€€€€€€€€Ñ¡”Ñİ¼Ù¥•İÌ…‰½Ù”Ñ¡¥ÌÉ•…‘Ì‘…¥±ä¡¥ÍÑ½ÉäÉ…Ñ¡•ÈÑ¡…¸¥¸µµ•µ½Éä4(€€€€€€€€€Í…¸ÍÑ…Ñ”°Í¼¥Ğ¥Ì¥¹™½Éµ…Ñ¥Ù”•Ù•¸İ¥Ñ Ñ¡”•¹¥¹”ÍÑ½ÁÁ•¸€¨½ô4(€€€€€ì…¥Í•µ¼€˜˜€ñ½ÉÉ•±…Ñ¥½¹!•…Ñ5…À€¼ùô4(4(€€€€€ì¼¨M…¹¹•ÈQ…‰±”ƒŠP±¥Ù”Á•ÈµÍ…¸Ù¥•Ü°¡¥‘‘•¸¥¸Ñ¡”‘•µ¼€¡¹¼•¹¥¹”¤¸€¨½ô4(€€€€€ì…¥Í•µ¼€˜˜€ 4(€€€€€€ñ½±±…ÁÍ¥‰±•M•Ñ¥½¸4(€€€€€€€¥ô‰Í…¹¹•Èˆ4(€€€€€€€Ñ¥Ñ±”ô‰1¥Ù”5…É­•ĞM…¹¹•Èˆ4(€€€€€€€¥½¸õíÑ¥Ù¥Ñåô4(€€€€€€€‘•™…Õ±Ñ=Á•¸õí™…±Í•ô4(€€€€€€€É¥¡Ğõì4(€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰Ñ•áĞµlÄÍÁátÑ•áĞµµÕÑ•µ™½É•É½Õ¹™½¹Ğµµ½¹¼™±•à¥Ñ•µÌµ•¹Ñ•È…À´Èˆø4(€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰É•±…Ñ¥Ù”™±•à ´ÈÜ´Èˆø4(€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰…¹¥µ…Ñ”µÁ¥¹œ…‰Í½±ÕÑ”¥¹±¥¹”µ™±•à µ™Õ±°Üµ™Õ±°É½Õ¹‘•µ™Õ±°‰œµÁÉ¥µ…Éä½Á…¥Ñä´ÜÔˆøğ½ÍÁ…¸ø4(€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰É•±…Ñ¥Ù”¥¹±¥¹”µ™±•àÉ½Õ¹‘•µ™Õ±° ´ÈÜ´È‰œµÁÉ¥µ…Éäˆøğ½ÍÁ…¸ø4(€€€€€€€€€€€€ğ½ÍÁ…¸ø4(€€€€€€€€€€€M…¹¹¥¹œíÍ…¹¹•Èü¹±•¹Ñ ñğ€ÁôÁ…¥ÉÌ4(€€€€€€€€€€ğ½ÍÁ…¸ø4(€€€€€€€ô4(€€€€€€ø4(€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰½Ù•É™±½Üµ…ÕÑ¼‰œµ…Éˆø4(€€€€€€€€€€€€ñQ…‰±”ø4(€€€€€€€€€€€€€€ñQ…‰±•!•…‘•Èø4(€€€€€€€€€€€€€€€€ñQ…‰±•I½Ü±…ÍÍ9…µ”ô‰¡½Ù•Èé‰œµÑÉ…¹ÍÁ…É•¹Ğˆø4(€€€€€€€€€€€€€€€€€€ñQ…‰±•!•…ùMåµ‰½°ğ½Q…‰±•!•…ø4(€€€€€€€€€€€€€€€€€€ñQ…‰±•!•…ùAÉ¥”ğ½Q…‰±•!•…ø4(€€€€€€€€€€€€€€€€€€ñQ…‰±•!•…ù½¹™¥‘•¹”ğ½Q…‰±•!•…ø4(€€€€€€€€€€€€€€€€€€ñQ…‰±•!•…ùIM$ğ½Q…‰±•!•…ø4(€€€€€€€€€€€€€€€€€€ñQ…‰±•!•…ùQH”ğ½Q…‰±•!•…ø4(€€€€€€€€€€€€€€€€€€ñQ…‰±•!•…ùMÑ…ÑÕÌğ½Q…‰±•!•…ø4(€€€€€€€€€€€€€€€€ğ½Q…‰±•I½Üø4(€€€€€€€€€€€€€€ğ½Q…‰±•!•…‘•Èø4(€€€€€€€€€€€€€€ñQ…‰±•	½‘äø4(€€€€€€€€€€€€€€€íÍ…¹¹•Èü¹µ…À ¡É½Ü¤€ôø€ 4(€€€€€€€€€€€€€€€€€€ñQ…‰±•I½Ü­•äõíÉ½Ü¹Íåµ‰½±ô±…ÍÍ9…µ”õí¸ 4(€€€€€€€€€€€€€€€€€€€É½Ü¹ÍÑ…ÑÕÌ€ôôô€•¹Ñ•É•œ€˜˜€‰‰œµÁÉ¥µ…Éä¼Ôˆ°4(€€€€€€€€€€€€€€€€€€€É½Ü¹ÍÑ…ÑÕÌ€ôôô€‰±…­±¥ÍÑ•œ€˜˜€‰½Á…¥Ñä´ÔÀˆ4(€€€€€€€€€€€€€€€€€€¥ôø4(€€€€€€€€€€€€€€€€€€€€ñQ…‰±••±°±…ÍÍ9…µ”ô‰™½¹Ğµ‰½±ˆùíÉ½Ü¹Íåµ‰½±ôğ½Q…‰±••±°ø4(€€€€€€€€€€€€€€€€€€€€ñQ…‰±••±°±…ÍÍ9…µ”ô‰™½¹Ğµµ½¹¼ˆùí™½Éµ…Ñ9Õµ‰•È¡É½Ü¹±…ÍÑAÉ¥”°€Ğ¥ôğ½Q…‰±••±°ø4(€€€€€€€€€€€€€€€€€€€€ñQ…‰±••±°±…ÍÍ9…µ”ô‰ÜµlÄÈÁÁátˆø4(€€€€€€€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È…À´Èˆø4(€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰™½¹Ğµµ½¹¼Ñ•áĞµlÄÍÁátÜ´ØˆùíÉ½Ü¹½¹™¥‘•¹•ôğ½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€€ñAÉ½É•ÍÍ	…È€4(€€€€€€€€€€€€€€€€€€€€€€€€€Ù…±Õ”õíÉ½Ü¹½¹™¥‘•¹•ô€4(€€€€€€€€€€€€€€€€€€€€€€€€€½±½É±…ÍÌõíÉ½Ü¹½¹™¥‘•¹”€ø€àÀ€ü€‰‰œµÍÕ•ÍÌˆ€èÉ½Ü¹½¹™¥‘•¹”€ø€ØÔ€ü€‰‰œµİ…É¹¥¹œˆ€è€‰‰œµ‘•ÍÑÉÕÑ¥Ù”‰ô€4(€€€€€€€€€€€€€€€€€€€€€€€€¼ø4(€€€€€€€€€€€€€€€€€€€€€€ğ½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€ğ½Q…‰±••±°ø4(€€€€€€€€€€€€€€€€€€€€ñQ…‰±••±°±…ÍÍ9…µ”ô‰™½¹Ğµµ½¹¼ˆø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”õí¸ 4(€€€€€€€€€€€€€€€€€€€€€€€É½Ü¹ÉÍ¤€ø€ÜÀ€ü€‰Ñ•áĞµ‘•ÍÑÉÕÑ¥Ù”ˆ€èÉ½Ü¹ÉÍ¤€ğ€ÌÀ€ü€‰Ñ•áĞµÍÕ•ÍÌˆ€è€‰Ñ•áĞµµÕÑ•µ™½É•É½Õ¹ˆ4(€€€€€€€€€€€€€€€€€€€€€€¥ôùí™½Éµ…Ñ9Õµ‰•È¡É½Ü¹ÉÍ¤°€Ä¥ôğ½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€ğ½Q…‰±••±°ø4(€€€€€€€€€€€€€€€€€€€€ñQ…‰±••±°±…ÍÍ9…µ”ô‰™½¹Ğµµ½¹¼ˆùí™½Éµ…Ñ9Õµ‰•È¡É½Ü¹…ÑÉA•É•¹Ğ°€È¥ô”ğ½Q…‰±••±°ø4(€€€€€€€€€€€€€€€€€€€€ñQ…‰±••±°ø4(€€€€€€€€€€€€€€€€€€€€€€ñ	…‘”Ù…É¥…¹Ğõì4(€€€€€€€€€€€€€€€€€€€€€€€É½Ü¹ÍÑ…ÑÕÌ€ôôô€•¹Ñ•É•œ€ü€‘•™…Õ±Ğœ€è€4(€€€€€€€€€€€€€€€€€€€€€€€É½Ü¹ÍÑ…ÑÕÌ€ôôô€‰±…­±¥ÍÑ•œ€ü€‘•ÍÑÉÕÑ¥Ù”œ€è€4(€€€€€€€€€€€€€€€€€€€€€€€É½Ü¹ÍÑ…ÑÕÌ€ôôô€İ…Ñ¡¥¹œœ€ü€½ÕÑ±¥¹”œ€è€Í•½¹‘…Éäœ4(€€€€€€€€€€€€€€€€€€€€€ôø4(€€€€€€€€€€€€€€€€€€€€€€€íÉ½Ü¹ÍÑ…ÑÕÍô4(€€€€€€€€€€€€€€€€€€€€€€ğ½	…‘”ø4(€€€€€€€€€€€€€€€€€€€€ğ½Q…‰±••±°ø4(€€€€€€€€€€€€€€€€€€ğ½Q…‰±•I½Üø4(€€€€€€€€€€€€€€€€¤¥ô4(€€€€€€€€€€€€€€€íÍ…¹¹•ÉÉÉ½È€˜˜€ 4(€€€€€€€€€€€€€€€€€€ñQ…‰±•I½Üø4(€€€€€€€€€€€€€€€€€€€€ñQ…‰±••±°½±MÁ…¸õìÙô±…ÍÍ9…µ”ô‰Ñ•áĞµ•¹Ñ•ÈÁä´àÑ•áĞµ‘•ÍÑÉÕÑ¥Ù”™½¹Ğµµ½¹¼Ñ•áĞµÍ´ˆø4(€€€€€€€€€€€€€€€€€€€€€U¹…‰±”Ñ¼±½…Í…¹¹•È‘…Ñ„ƒŠP¡•¬A$½¹¹•Ñ¥Ù¥Ñä¸4(€€€€€€€€€€€€€€€€€€€€ğ½Q…‰±••±°ø4(€€€€€€€€€€€€€€€€€€ğ½Q…‰±•I½Üø4(€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€ì…Í…¹¹•ÉÉÉ½È€˜˜Í…¹¹•É1½…‘¥¹œ€˜˜€ 4(€€€€€€€€€€€€€€€€€€ñQ…‰±•I½Üø4(€€€€€€€€€€€€€€€€€€€€ñQ…‰±••±°½±MÁ…¸õìÙô±…ÍÍ9…µ”ô‰Ñ•áĞµ•¹Ñ•ÈÁä´àÑ•áĞµµÕÑ•µ™½É•É½Õ¹™½¹Ğµµ½¹¼Ñ•áĞµÍ´ˆø4(€€€€€€€€€€€€€€€€€€€€€1½…‘¥¹œÍ…¹¹•È‘…Ñ‡Š˜4(€€€€€€€€€€€€€€€€€€€€ğ½Q…‰±••±°ø4(€€€€€€€€€€€€€€€€€€ğ½Q…‰±•I½Üø4(€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€ì…Í…¹¹•ÉÉÉ½È€˜˜€…Í…¹¹•É1½…‘¥¹œ€˜˜€ …Í…¹¹•ÈñğÍ…¹¹•È¹±•¹Ñ €ôôô€À¤€˜˜€ 4(€€€€€€€€€€€€€€€€€€ñQ…‰±•I½Üø4(€€€€€€€€€€€€€€€€€€€€ñQ…‰±••±°½±MÁ…¸õìÙô±…ÍÍ9…µ”ô‰Ñ•áĞµ•¹Ñ•ÈÁä´àÑ•áĞµµÕÑ•µ™½É•É½Õ¹™½¹Ğµµ½¹¼Ñ•áĞµÍ´ˆø4(€€€€€€€€€€€€€€€€€€€€€9¼Á…¥ÉÌµ…Ñ¡¥¹œÍ…¸É¥Ñ•É¥„¸4(€€€€€€€€€€€€€€€€€€€€ğ½Q…‰±••±°ø4(€€€€€€€€€€€€€€€€€€ğ½Q…‰±•I½Üø4(€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€ğ½Q…‰±•	½‘äø4(€€€€€€€€€€€€ğ½Q…‰±”ø4(€€€€€€€€€€ğ½‘¥Øø4(€€€€€€ğ½½±±…ÁÍ¥‰±•M•Ñ¥½¸ø4(€€€€€€¥ô4(€€€€ğ½‘¥Øø4(€€¤ì4)ô4(
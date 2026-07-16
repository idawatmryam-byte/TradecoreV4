import { useGetBotStatus, useGetScannerData, useStartBot, useStopBot, getGetBotStatusQueryKey, getGetScannerDataQueryKey, getGetTradesQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui";
import { formatCurrency, formatPercent, formatNumber } from "@/lib/utils";
import { Power, Square, Activity, TrendingUp, AlertTriangle, ArrowUpRight, ArrowDownRight, WifiOff, X, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";
import { BlockingBanner, MarketMonitor, DecisionPanel } from "@/components/verification";
import { useState, type ReactNode } from "react";

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
function CollapsibleSection({ id, title, icon: Icon, right, defaultOpen = true, children }: {
  id: string;
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Extra header content (e.g. a live count) — shown even while collapsed. */
  right?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const storageKey = `cockpit-panel:${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored == null ? defaultOpen : stored === "1";
    } catch { return defaultOpen; }
  });
  const toggle = () => setOpen((o) => {
    const next = !o;
    try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* private mode */ }
    return next;
  });
  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={cn(
          "w-full flex items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-2.5 text-left transition-colors hover:bg-muted/40",
          open && "rounded-b-none border-b-0",
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon className="h-4 w-4 text-primary shrink-0" />}
          <span className="text-sm font-mono tracking-wider uppercase font-semibold truncate">{title}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {right}
          {open
            ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>
      {open && (
        <div className="rounded-b-md border border-t-0 border-border overflow-hidden">
          {children}
        </div>
      )}
    </section>
  );
}

function ProgressBar({ value, colorClass }: { value: number, colorClass: string }) {
  return (
    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
      <div className={cn("h-full transition-all duration-500", colorClass)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

/** Compact KPI tile — scales its type/padding down on small screens so a row of
 *  these stays readable on a phone instead of overflowing. */
function Stat({ label, value, valueClass, sub }: {
  label: string; value: ReactNode; valueClass?: string; sub?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4 sm:p-6">
        <p className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider mb-1.5 sm:mb-2">{label}</p>
        <p className={cn("text-2xl sm:text-3xl font-bold tracking-tight tabular-nums truncate", valueClass)}>{value}</p>
        {sub}
      </CardContent>
    </Card>
  );
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
  return (
    <div className="bg-card">
      {positions && positions.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 p-3">
          {positions.map((p) => {
            const isProfit = p.unrealizedPnl >= 0;
            const isClosing = closingId === p.tradeId;
            const isConfirming = confirmingClose === p.tradeId;
            return (
              <div key={p.tradeId} className="rounded-lg border border-border/60 p-4 bg-background/40 hover:bg-muted/20 transition-colors">
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
                    <span className="block text-[9px] font-normal text-muted-foreground uppercase">
                      {p.unrealizedPnlPercent >= 0 ? "+" : ""}{p.unrealizedPnlPercent.toFixed(2)}% unrealized
                    </span>
                  </div>
                </div>
                {p.strategyName && (
                  <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-2">
                    {p.strategyName} · held {formatHeld(p.holdingSeconds)}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 text-xs font-mono text-muted-foreground">
                  <div>
                    <span className="block opacity-50 uppercase mb-0.5">Entry → Now</span>
                    <span className="text-foreground">
                      {formatNumber(p.entryPrice, 4)} → {formatNumber(p.currentPrice, 4)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="block opacity-50 uppercase mb-0.5">Size</span>
                    <span className="text-foreground">{formatNumber(p.remainingQuantity, 4)}</span>
                  </div>
                  <div>
                    <span className="block opacity-50 uppercase mb-0.5">Stop Loss</span>
                    <span className="text-destructive">{formatNumber(p.stopLossPrice, 4)}</span>
                  </div>
                  <div className="text-right">
                    <span className="block opacity-50 uppercase mb-0.5">Take Profit</span>
                    <span className="text-success">
                      {p.tp1Price != null && !p.tp1Filled
                        ? `${formatNumber(p.tp1Price, 4)} / ${formatNumber(p.takeProfitPrice, 4)}`
                        : formatNumber(p.takeProfitPrice, 4)}
                    </span>
                  </div>
                </div>
                <div className="mt-3">
                  {isConfirming ? (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        className="flex-1 h-8 text-xs gap-1.5"
                        disabled={isClosing}
                        onClick={() => onClose(p.tradeId, p.symbol)}
                      >
                        {isClosing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                        Confirm close at market
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={isClosing} onClick={() => onArmClose(null)}>
                        Keep
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-8 text-xs gap-1.5 text-muted-foreground hover:text-destructive hover:border-destructive/50"
                      onClick={() => onArmClose(p.tradeId)}
                    >
                      <X className="h-3.5 w-3.5" /> Close Position
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <div className="p-8 text-center text-destructive flex flex-col items-center justify-center">
          <WifiOff className="h-8 w-8 mb-3 opacity-50" />
          <p className="font-mono text-sm uppercase tracking-wider">Unable to load positions</p>
          <p className="text-xs text-muted-foreground mt-1 normal-case">Open positions may still exist — check the exchange directly.</p>
        </div>
      )}
      {!error && loading && (
        <div className="p-8 text-center text-muted-foreground">
          <p className="font-mono text-sm uppercase tracking-wider">Loading positions…</p>
        </div>
      )}
      {!error && !loading && (!positions || positions.length === 0) && (
        <div className="p-8 text-center text-muted-foreground flex flex-col items-center justify-center">
          <AlertTriangle className="h-8 w-8 mb-3 opacity-20" />
          <p className="font-mono text-sm uppercase tracking-wider">No active positions</p>
          <p className="text-xs mt-1 normal-case">Trades opened by the engine appear here with live P&L and controls.</p>
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: bot, isLoading: botLoading, isError: botError } = useGetBotStatus({ query: { refetchInterval: 5000, queryKey: getGetBotStatusQueryKey() } });
  const { data: scanner, isLoading: scannerLoading, isError: scannerError } = useGetScannerData({ query: { refetchInterval: 15000, queryKey: getGetScannerDataQueryKey() } });
  const { data: positions, isLoading: tradesLoading, isError: tradesError } = useQuery<ActivePosition[]>({
    queryKey: ["trades-monitor-active"],
    refetchInterval: 5000,
    queryFn: async () => {
      const res = await fetch("/api/trades/monitor/active", { credentials: "same-origin" });
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
      const res = await fetch(`/api/trades/${tradeId}/close`, { method: "POST", credentials: "same-origin" });
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

  const startBot = useStartBot();
  const stopBot = useStopBot();

  const handleStart = () => startBot.mutate(undefined, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() }) });
  const handleStop = () => stopBot.mutate(undefined, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() }) });

  return (
    <div className="max-w-6xl mx-auto space-y-4 sm:space-y-6">

      {/* Open Positions — pinned to the top of the cockpit */}
      <CollapsibleSection
        id="positions"
        title="Open Positions"
        icon={TrendingUp}
        right={
          <span className="text-xs font-mono text-muted-foreground">
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

      {/* Hero Control Panel */}
      <CollapsibleSection
        id="engine"
        title="Trading Engine"
        icon={Power}
        right={
          <span className={cn(
            "text-xs font-mono font-bold",
            statusUnknown ? "text-muted-foreground" : bot?.running ? "text-success" : "text-destructive",
          )}>
            {statusUnknown ? "UNKNOWN" : bot?.running ? "ACTIVE" : "STANDBY"}
          </span>
        }
      >
      <div className="p-3 sm:p-4 grid grid-cols-1 md:grid-cols-4 gap-4 sm:gap-6">
        <Card className="md:col-span-2 relative overflow-hidden bg-card/50 border-primary/20 backdrop-blur">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent pointer-events-none" />
          <CardContent className="p-6 sm:p-8 flex flex-col justify-between h-full gap-6 relative z-10">
            <div>
              <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest mb-1">Trading Engine</h2>
              <div className="flex items-center gap-3 mb-6">
                <span className={cn("relative flex h-3 w-3")}>
                  {bot?.running && !statusUnknown && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>}
                  <span className={cn("relative inline-flex rounded-full h-3 w-3", statusUnknown ? "bg-muted-foreground" : bot?.running ? "bg-success" : "bg-destructive")}></span>
                </span>
                <span className="text-xl sm:text-2xl font-bold tracking-tight">
                  {statusUnknown ? "STATUS UNKNOWN" : bot?.running ? "SYSTEM ACTIVE" : "SYSTEM STANDBY"}
                </span>
              </div>
              {botError && (
                <div className="flex items-start gap-2 mb-4 text-xs font-mono text-destructive">
                  <WifiOff className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>Can't reach the API — this is NOT a confirmed idle state. Open positions may still exist.</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 sm:gap-4">
              <Button
                size="lg"
                className={cn("flex-1 sm:flex-none sm:w-40 font-mono tracking-wider font-bold transition-all", bot?.running ? "opacity-50 cursor-not-allowed" : "bg-success text-success-foreground hover:bg-success/90")}
                onClick={handleStart}
                disabled={bot?.running || startBot.isPending}
              >
                <Power className="mr-2 h-4 w-4" /> START
              </Button>
              <Button
                size="lg"
                variant="destructive"
                className={cn("flex-1 sm:flex-none sm:w-40 font-mono tracking-wider font-bold transition-all", !bot?.running ? "opacity-50 cursor-not-allowed" : "")}
                onClick={handleStop}
                disabled={!bot?.running || stopBot.isPending}
              >
                <Square className="mr-2 h-4 w-4" /> STOP
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
              <p className="text-[10px] font-mono text-muted-foreground mt-1 uppercase truncate">USDT · {bot?.mode}</p>
            )}
          />
          <Stat
            label="Today's PnL"
            valueClass={statusUnknown ? "text-muted-foreground" : (bot?.dailyPnl ?? 0) >= 0 ? "text-success" : "text-destructive"}
            value={statusUnknown ? "—" : formatCurrency(bot?.dailyPnl, "always")}
          />
          {/* winRateToday is a 0–1 fraction; formatPercent expects 0–100. */}
          <Stat
            label="Win Rate"
            valueClass={statusUnknown ? "text-muted-foreground" : "text-primary"}
            value={statusUnknown ? "—" : formatPercent((bot?.winRateToday ?? 0) * 100)}
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

      {/* Why is / isn't it trading — exact blocking condition */}
      <BlockingBanner />

      {/* Verification: live market data + full strategy decision pipeline */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6 items-start">
        <CollapsibleSection id="market-monitor" title="Market Monitor" icon={Activity}>
          <div className="p-3"><MarketMonitor /></div>
        </CollapsibleSection>
        <CollapsibleSection id="decision-panel" title="Decision Pipeline" icon={Activity}>
          <div className="p-3"><DecisionPanel /></div>
        </CollapsibleSection>
      </div>

      {/* Scanner Table */}
      <CollapsibleSection
        id="scanner"
        title="Live Market Scanner"
        icon={Activity}
        right={
          <span className="text-xs text-muted-foreground font-mono flex items-center gap-2">
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
                        <span className="font-mono text-xs w-6">{row.confidence}</span>
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
    </div>
  );
}

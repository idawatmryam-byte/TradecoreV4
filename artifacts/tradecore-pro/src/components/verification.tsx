import {
  useGetMarketLive, getGetMarketLiveQueryKey,
  useGetBotDecisions, getGetBotDecisionsQueryKey,
  useGetBlockingSummary, getGetBlockingSummaryQueryKey,
} from "@workspace/api-client-react";
import type { PipelineStage, SymbolDecision } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Badge } from "@/components/ui";
import {
  Activity, Wifi, WifiOff, CheckCircle2, XCircle, MinusCircle,
  ShieldCheck, Ban, ChevronRight, Gauge, ArrowUp, ArrowDown,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Blocking banner — the prominent "why is / isn't it trading" headline.
// ---------------------------------------------------------------------------
export function BlockingBanner() {
  const { data } = useGetBlockingSummary({
    query: { refetchInterval: 5000, queryKey: getGetBlockingSummaryQueryKey() },
  });
  if (!data) return null;

  // Actively trading (or able to) — green all-clear.
  if (data.tradingActive && !data.globalBlock) {
    return (
      <Card className="border-success/30 bg-success/5">
        <CardContent className="p-4 flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-success shrink-0" />
          <div>
            <p className="font-mono text-sm font-bold text-success uppercase tracking-wider">
              Engine clear to trade
            </p>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              {data.entered > 0
                ? `${data.entered} entr${data.entered === 1 ? "y" : "ies"} this scan · `
                : ""}
              {data.totalEvaluated} pairs evaluated · no blocking conditions
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Something is blocking — surface the exact condition.
  const headline =
    data.globalBlock ??
    (data.reasons.length > 0
      ? "No trades taken — every candidate was blocked"
      : "No entry conditions met this scan");

  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Ban className="h-5 w-5 text-warning shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-mono text-sm font-bold text-warning uppercase tracking-wider">
              {data.running ? "No trade executed" : "Engine stopped"}
            </p>
            <p className="text-sm text-foreground mt-1">{headline}</p>

            {!data.globalBlock && data.reasons.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {data.reasons.map((r) => (
                  <div key={`${r.stage}-${r.reason}`} className="flex items-start gap-2 text-xs font-mono">
                    <Badge variant="secondary" className="h-5 shrink-0">{r.count}</Badge>
                    <div className="min-w-0">
                      <span className="text-foreground">{r.reason}</span>
                      <span className="text-muted-foreground"> — {r.stage}</span>
                      <span className="text-muted-foreground/60 block truncate">
                        {r.symbols.slice(0, 8).join(", ")}{r.symbols.length > 8 ? "…" : ""}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Live market monitor — real ticker snapshots + connection health.
// ---------------------------------------------------------------------------
export function MarketMonitor() {
  const { data } = useGetMarketLive({
    query: { refetchInterval: 3000, queryKey: getGetMarketLiveQueryKey() },
  });

  const conn = data?.connection;
  const tickers = data?.tickers ?? [];

  return (
    <Card className="flex flex-col">
      <CardHeader className="py-4 border-b border-border/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-mono tracking-wider uppercase">Live Market Monitor</CardTitle>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono">
            {conn?.connected ? (
              <><Wifi className="h-3.5 w-3.5 text-success" /><span className="text-success">LIVE</span></>
            ) : (
              <><WifiOff className="h-3.5 w-3.5 text-destructive" /><span className="text-destructive">OFFLINE</span></>
            )}
          </div>
        </div>
        {conn && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] font-mono text-muted-foreground">
            <span>{conn.exchange} <span className="uppercase">({conn.mode})</span></span>
            <span>{conn.marketsLoaded} markets</span>
            <span className={conn.credentialsVerified ? "text-success" : "text-warning"}>
              {conn.credentialsVerified ? "creds ✓" : "creds ✗"}
            </span>
            {conn.lastTickerLatencyMs != null && <span>{conn.lastTickerLatencyMs}ms</span>}
            {conn.lastTickerFetchAt && (
              <span>updated {new Date(conn.lastTickerFetchAt).toLocaleTimeString()}</span>
            )}
          </div>
        )}
        {conn?.lastError && (
          <p className="text-[11px] font-mono text-destructive mt-1 truncate">⚠ {conn.lastError}</p>
        )}
      </CardHeader>

      <div className="overflow-auto flex-1">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card">
            <tr className="text-left text-xs font-mono text-muted-foreground uppercase border-b border-border/50">
              <th className="p-3 font-medium">Symbol</th>
              <th className="p-3 font-medium text-right">Last</th>
              <th className="p-3 font-medium text-right">Bid / Ask</th>
              <th className="p-3 font-medium text-right">Spread</th>
              <th className="p-3 font-medium text-right">24h</th>
              <th className="p-3 font-medium text-right">Volume (USDT)</th>
            </tr>
          </thead>
          <tbody>
            {tickers.map((t) => (
              <tr key={t.symbol} className="border-b border-border/30 hover:bg-muted/30">
                <td className="p-3 font-bold">{t.symbol}</td>
                <td className="p-3 text-right font-mono">{formatNumber(t.last, 4)}</td>
                <td className="p-3 text-right font-mono text-xs text-muted-foreground">
                  {formatNumber(t.bid, 4)} / {formatNumber(t.ask, 4)}
                </td>
                <td className="p-3 text-right font-mono text-xs">{formatNumber(t.spreadPercent, 3)}%</td>
                <td className={cn(
                  "p-3 text-right font-mono",
                  t.changePercent >= 0 ? "text-success" : "text-destructive"
                )}>
                  <span className="inline-flex items-center gap-0.5 justify-end">
                    {t.changePercent >= 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                    {formatNumber(Math.abs(t.changePercent), 2)}%
                  </span>
                </td>
                <td className="p-3 text-right font-mono text-xs text-muted-foreground">
                  {formatCompact(t.quoteVolume)}
                </td>
              </tr>
            ))}
            {tickers.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-8 text-muted-foreground font-mono text-sm">
                  {conn?.connected ? "Waiting for ticker data…" : "Start the engine to stream live market data."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Strategy decision panel — the full per-symbol pipeline with the exact
// reason each trade was or wasn't taken.
// ---------------------------------------------------------------------------
function StageIcon({ status }: { status: PipelineStage["status"] }) {
  if (status === "pass") return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (status === "fail") return <XCircle className="h-4 w-4 text-destructive" />;
  return <MinusCircle className="h-4 w-4 text-muted-foreground/40" />;
}

function DecisionRow({ d }: { d: SymbolDecision }) {
  const [open, setOpen] = useState(false);
  const entered = d.finalDecision === "ENTERED";

  return (
    <div className={cn("border-b border-border/40", entered && "bg-success/5")}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/30 transition-colors"
      >
        <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform shrink-0", open && "rotate-90")} />
        <span className="font-bold w-24 shrink-0">{d.symbol}</span>

        {/* Compact pipeline: 5 stage dots */}
        <div className="flex items-center gap-1.5 shrink-0">
          {d.stages.map((s, i) => (
            <div key={s.name} className="flex items-center gap-1.5">
              <StageIcon status={s.status} />
              {i < d.stages.length - 1 && <span className="text-muted-foreground/20">·</span>}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-auto shrink-0 text-xs font-mono text-muted-foreground">
          <Gauge className="h-3 w-3" />{formatNumber(d.confidence, 0)}%
        </div>
        <Badge variant={entered ? "success" : "secondary"} className="shrink-0 w-24 justify-center">
          {entered ? "ENTERED" : "BLOCKED"}
        </Badge>
      </button>

      {/* Block reason preview (always visible when blocked) */}
      {!entered && d.blockReason && !open && (
        <p className="px-3 pb-2 -mt-1 pl-10 text-xs font-mono text-warning truncate">
          {d.blockStage}: {d.blockReason}
        </p>
      )}

      {open && (
        <div className="px-3 pb-3 pl-10 space-y-2">
          {d.stages.map((s) => (
            <div key={s.name} className="flex items-start gap-2 text-xs">
              <StageIcon status={s.status} />
              <div className="min-w-0">
                <span className="font-mono font-bold text-foreground">{s.name}</span>
                <span className="text-muted-foreground"> — {s.detail}</span>
              </div>
            </div>
          ))}
          {!entered && d.blockReason && (
            <div className="mt-2 rounded bg-warning/10 border border-warning/30 p-2 text-xs font-mono text-warning">
              Blocked at <b>{d.blockStage}</b>: {d.blockReason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DecisionPanel() {
  const { data } = useGetBotDecisions({
    query: { refetchInterval: 15000, queryKey: getGetBotDecisionsQueryKey() },
  });
  const decisions = data ?? [];

  return (
    <Card className="flex flex-col">
      <CardHeader className="py-4 border-b border-border/50">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <CardTitle className="text-sm font-mono tracking-wider uppercase">Strategy Decision Panel</CardTitle>
        </div>
        <p className="text-[11px] font-mono text-muted-foreground mt-1">
          Market Data → Indicators → Signal → Risk Checks → Order · click a row for the full trace
        </p>
      </CardHeader>
      <div className="overflow-auto flex-1">
        {decisions.map((d) => <DecisionRow key={d.symbol} d={d} />)}
        {decisions.length === 0 && (
          <div className="p-8 text-center text-muted-foreground font-mono text-sm">
            No decisions yet — start the engine and wait for the first scan.
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return formatNumber(n, 0);
}

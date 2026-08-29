import { useGetTrades, getGetTradesQueryKey, type GetTradesStatus, type Trade } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Table, TableHeader, TableRow, TableHead, TableBody, TableCell, Badge, Button } from "@/components/ui";
import { formatCurrency, formatNumber, formatDate } from "@/lib/utils";
import { History, ArrowUpRight, ArrowDownRight, Filter, WifiOff, Download, BrainCircuit, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { PageHeader, PageTabs, EmptyState, LoadingRows } from "@/components/patterns";
import { PositionThesisCard } from "@/components/position-thesis-card";

// Fetch the API's maximum so the CSV export covers as much history as one
// request allows (the on-screen table simply scrolls).
const FETCH_LIMIT = 500;

function symbolUnits(symbol: string): { base: string | null; quote: string | null } {
  const normalized = symbol.toUpperCase();
  const separated = normalized.match(/^([A-Z0-9]+)[_\/]([A-Z0-9]+)$/);
  if (separated) return { base: separated[1] ?? null, quote: separated[2] ?? null };

  for (const quote of ["USDT", "USDC", "USD", "EUR", "GBP", "JPY", "BTC", "ETH"]) {
    if (normalized.endsWith(quote) && normalized.length > quote.length) {
      return { base: normalized.slice(0, -quote.length), quote };
    }
  }
  return { base: null, quote: null };
}

function TradeField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/60 bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm">{value}</p>
    </div>
  );
}

function TradeDetailsCard({ trade, onClose }: { trade: Trade; onClose: () => void }) {
  const units = symbolUnits(trade.symbol);
  const quantity = `${formatNumber(trade.quantity, 4)} ${units.base ?? "units"}`;
  const entryNotional = trade.entryPrice * trade.quantity;
  const notional = units.quote
    ? `${formatNumber(entryNotional, 2)} ${units.quote}`
    : "Unavailable";

  return (
    <Card data-testid="trade-details-card">
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
        <div>
          <CardTitle role="heading" aria-level={2}>Trade #{trade.id} details</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {trade.symbol} · {trade.side === "buy" ? "LONG" : "SHORT"} · {trade.status.toUpperCase()}
          </p>
        </div>
        <Button variant="ghost" size="sm" aria-label="Close trade details" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TradeField label="Strategy" value={trade.strategyName ?? trade.strategyId ?? "Unavailable"} />
        <TradeField label="Quantity" value={quantity} />
        <TradeField label="Entry notional" value={notional} />
        <TradeField label="Market" value={trade.marketType === "futures" ? "Futures" : trade.marketType === "forex" ? "Forex" : "Spot"} />
        <TradeField label="Entry price" value={formatNumber(trade.entryPrice, 4)} />
        <TradeField label="Exit price" value={trade.exitPrice != null ? formatNumber(trade.exitPrice, 4) : "Unavailable"} />
        <TradeField label="Stop loss" value={formatNumber(trade.stopLoss, 4)} />
        <TradeField label="Take profit" value={formatNumber(trade.takeProfit, 4)} />
        <TradeField label="Leverage" value={trade.leverage != null ? `${trade.leverage}×` : "Unavailable"} />
        <TradeField label="Margin mode" value={trade.marginMode ? trade.marginMode.toUpperCase() : "Unavailable"} />
        <TradeField label="Realized P&L" value={trade.pnl != null ? formatCurrency(trade.pnl, "always") : "Unavailable"} />
        <TradeField label="Fees" value={trade.feesUsdt != null ? formatCurrency(trade.feesUsdt, "always") : "Unavailable"} />
        <TradeField label="Opened" value={formatDate(trade.entryTime)} />
        <TradeField label="Closed" value={trade.exitTime ? formatDate(trade.exitTime) : "Unavailable"} />
        <TradeField label="Exit reason" value={trade.exitReason?.replaceAll("_", " ") ?? "Unavailable"} />
      </CardContent>
    </Card>
  );
}

/** Portfolio's two views. Separate routes, one destination. */
export const PORTFOLIO_TABS = [
  { href: "/trades", label: "Trade Log" },
  { href: "/journal", label: "Journal" },
];

const STATUS_FILTERS: { label: string; value: GetTradesStatus | undefined }[] = [
  { label: "All", value: undefined },
  { label: "Open", value: "open" },
  { label: "Closed", value: "closed" },
  { label: "Stopped", value: "stopped" },
];

export function Trades() {
  const [filter, setFilter] = useState<GetTradesStatus | undefined>(undefined);
  const [selectedTradeId, setSelectedTradeId] = useState<number | null>(null);

  const { data: trades, isLoading, isError } = useGetTrades(
    { status: filter, limit: FETCH_LIMIT },
    { query: { refetchInterval: 10000, queryKey: getGetTradesQueryKey({ status: filter, limit: FETCH_LIMIT }) } }
  );
  const selectedTrade = trades?.find((trade) => trade.id === selectedTradeId);

  // Everything the Trade type exposes, one row per trade — analysis-ready.
  function downloadCsv() {
    if (!trades || trades.length === 0) return;
    const cols = [
      "id", "symbol", "side", "status", "entryTime", "exitTime", "entryPrice", "exitPrice",
      "quantity", "remainingQuantity", "pnl", "grossPnl", "feesUsdt", "slippageUsdt",
      "stopLoss", "takeProfit", "plannedStopLoss", "plannedTakeProfit", "confidence",
      "exitReason", "holdingSeconds", "tp1Filled", "tp2Filled", "breakEvenActive",
      "trailingStopActive", "trailingStopMode", "managementAuthority", "managementMode",
      "managementPolicyVersion", "thesisId", "phase7ReductionApplied", "isBacktest",
    ] as const;
    const esc = (v: unknown) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = trades.map((t) => cols.map((c) => esc((t as unknown as Record<string, unknown>)[c])).join(","));
    const blob = new Blob([[cols.join(","), ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tradecore-trades-${filter ?? "all"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="max-w-6xl mx-auto space-y-4 sm:space-y-6">
      <PageHeader
        icon={History}
        title="Portfolio"
        description="Every position the engine has opened, and what became of it."
        actions={
          <Button variant="outline" size="sm" onClick={downloadCsv} disabled={!trades || trades.length === 0} className="gap-1.5">
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        }
      />

      <PageTabs tabs={PORTFOLIO_TABS} />

      {/* Status filter. Horizontally scrollable on phones so the four controls
          never overflow the page; inline from small up. */}
      <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1">
        <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
        {STATUS_FILTERS.map((f) => (
          <Button
            key={f.label}
            variant={filter === f.value ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFilter(f.value)}
            className="shrink-0"
          >
            {f.label}
          </Button>
        ))}
      </div>

      <Card>
        <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Side</TableHead>
                <TableHead>Entry / Exit</TableHead>
                <TableHead>Size</TableHead>
                <TableHead className="text-right">PnL</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Exit Reason</TableHead>
                <TableHead>Management</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!isError && !isLoading && trades?.map((trade) => {
                const isClosed = trade.status !== 'open';
                const isProfit = (trade.pnl ?? 0) >= 0;

                return (
                  <TableRow key={trade.id}>
                    <TableCell className="font-mono text-[13px] text-muted-foreground whitespace-nowrap">
                      {formatDate(trade.entryTime)}
                    </TableCell>
                    <TableCell className="font-bold">{trade.symbol}</TableCell>
                    <TableCell>
                      <span className={cn(
                        "text-[13px] font-bold",
                        trade.side === 'buy' ? "text-success" : "text-destructive"
                      )}>
                        {trade.side}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-[13px]">
                      <div>{formatNumber(trade.entryPrice, 4)}</div>
                      {trade.exitPrice && (
                        <div className="text-muted-foreground flex items-center gap-1 mt-0.5">
                          <span className="opacity-50">→</span> {formatNumber(trade.exitPrice, 4)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[13px]">
                      {formatNumber(trade.quantity, 4)} {symbolUnits(trade.symbol).base ?? "units"}
                    </TableCell>
                    <TableCell className="text-right">
                      {(trade.pnl !== null && trade.pnl !== undefined) ? (
                        <div className={cn("font-mono font-bold flex items-center justify-end gap-1", isProfit ? "text-success" : "text-destructive")}>
                          {isProfit ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                          {formatCurrency(trade.pnl, "always")}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={
                        trade.status === 'open' ? 'default' : 
                        trade.status === 'closed' ? 'secondary' : 'destructive'
                      }>
                        {trade.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-[13px] text-muted-foreground">
                      {trade.exitReason?.replace('_', ' ') || '-'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant={trade.managementAuthority === "phase7" ? "success" : trade.managementMode === "phase7_shadow" ? "outline" : "secondary"}>
                          {trade.managementMode === "phase7_active" ? "Phase 7 active" : trade.managementMode === "phase7_shadow" ? "Phase 7 shadow" : "Fixed"}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`View ${trade.symbol} trade details`}
                          aria-pressed={selectedTradeId === trade.id}
                          onClick={() => setSelectedTradeId((current) => current === trade.id ? null : trade.id)}
                        >
                          Details
                        </Button>
                        {trade.thesisId && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`View thesis for trade ${trade.id}`}
                            onClick={() => setSelectedTradeId((current) => current === trade.id ? null : trade.id)}
                          >
                            <BrainCircuit className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {isError && (
                <TableRow>
                  <TableCell colSpan={9} className="p-0">
                    <EmptyState
                      icon={WifiOff}
                      title="Couldn't load your trades"
                      description="The API didn't respond. Any open positions still hold their exchange-side stop-loss and take-profit — this is a read failure, not a change."
                      action={{ label: "Try again", onClick: () => window.location.reload() }}
                    />
                  </TableCell>
                </TableRow>
              )}
              {!isError && isLoading && (
                <TableRow>
                  <TableCell colSpan={9} className="p-0">
                    <LoadingRows rows={6} />
                  </TableCell>
                </TableRow>
              )}
              {!isError && !isLoading && (!trades || trades.length === 0) && (
                <TableRow>
                  <TableCell colSpan={9} className="p-0">
                    <EmptyState
                      icon={History}
                      title={filter ? `No ${filter} trades` : "No trades yet"}
                      description={
                        filter
                          ? "Nothing matches this filter. Try All to see the full history."
                          : "The engine opens a position when a strategy finds a setup that clears your risk rules. Start it from the Dashboard and the first trade will appear here."
                      }
                      action={filter ? { label: "Show all", onClick: () => setFilter(undefined) } : { label: "Go to Dashboard", href: "/" }}
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
      {selectedTrade && (
        <>
          <TradeDetailsCard trade={selectedTrade} onClose={() => setSelectedTradeId(null)} />
          {selectedTrade.thesisId && (
            <PositionThesisCard
              tradeId={selectedTrade.id}
              currentStopLoss={selectedTrade.stopLoss}
              remainingQuantity={selectedTrade.remainingQuantity ?? selectedTrade.quantity}
            />
          )}
        </>
      )}
    </div>
  );
}

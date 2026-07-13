import { useGetBotStatus, useGetScannerData, useGetTrades, useStartBot, useStopBot, getGetBotStatusQueryKey, getGetScannerDataQueryKey, getGetTradesQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui";
import { formatCurrency, formatPercent, formatNumber } from "@/lib/utils";
import { Power, Square, Activity, TrendingUp, AlertTriangle, ArrowUpRight, ArrowDownRight, WifiOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { BlockingBanner, MarketMonitor, DecisionPanel } from "@/components/verification";

function ProgressBar({ value, colorClass }: { value: number, colorClass: string }) {
  return (
    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
      <div className={cn("h-full transition-all duration-500", colorClass)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Dashboard() {
  const queryClient = useQueryClient();
  
  const { data: bot, isLoading: botLoading, isError: botError } = useGetBotStatus({ query: { refetchInterval: 5000, queryKey: getGetBotStatusQueryKey() } });
  const { data: scanner, isLoading: scannerLoading, isError: scannerError } = useGetScannerData({ query: { refetchInterval: 15000, queryKey: getGetScannerDataQueryKey() } });
  const { data: trades, isLoading: tradesLoading, isError: tradesError } = useGetTrades({ status: 'open', limit: 10 }, { query: { refetchInterval: 10000, queryKey: getGetTradesQueryKey({ status: 'open', limit: 10 }) } });

  // Distinguish "genuinely flat/idle" from "can't reach the API" — otherwise
  // a failed fetch renders identically to a real 0-position, 0-PnL bot.
  const statusUnknown = botLoading || botError;

  const startBot = useStartBot();
  const stopBot = useStopBot();

  const handleStart = () => startBot.mutate(undefined, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() }) });
  const handleStop = () => stopBot.mutate(undefined, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() }) });

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      
      {/* Hero Control Panel */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card className="md:col-span-2 relative overflow-hidden bg-card/50 border-primary/20 backdrop-blur">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent pointer-events-none" />
          <CardContent className="p-8 flex flex-col justify-between h-full relative z-10">
            <div>
              <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest mb-1">Trading Engine</h2>
              <div className="flex items-center gap-3 mb-6">
                <span className={cn("relative flex h-3 w-3")}>
                  {bot?.running && !statusUnknown && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>}
                  <span className={cn("relative inline-flex rounded-full h-3 w-3", statusUnknown ? "bg-muted-foreground" : bot?.running ? "bg-success" : "bg-destructive")}></span>
                </span>
                <span className="text-2xl font-bold tracking-tight">
                  {statusUnknown ? "STATUS UNKNOWN" : bot?.running ? "SYSTEM ACTIVE" : "SYSTEM STANDBY"}
                </span>
              </div>
              {botError && (
                <div className="flex items-center gap-2 mb-4 text-xs font-mono text-destructive">
                  <WifiOff className="h-3.5 w-3.5" />
                  Can't reach the API — this is NOT a confirmed idle state. Open positions may still exist.
                </div>
              )}
            </div>

            <div className="flex items-center gap-4">
              <Button 
                size="lg" 
                className={cn("w-40 font-mono tracking-wider font-bold transition-all", bot?.running ? "opacity-50 cursor-not-allowed" : "bg-success text-success-foreground hover:bg-success/90")}
                onClick={handleStart}
                disabled={bot?.running || startBot.isPending}
              >
                <Power className="mr-2 h-4 w-4" /> START
              </Button>
              <Button 
                size="lg" 
                variant="destructive"
                className={cn("w-40 font-mono tracking-wider font-bold transition-all", !bot?.running ? "opacity-50 cursor-not-allowed" : "")}
                onClick={handleStop}
                disabled={!bot?.running || stopBot.isPending}
              >
                <Square className="mr-2 h-4 w-4" /> STOP
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Quick Stats */}
        <div className="grid grid-cols-1 gap-6 md:col-span-2">
          <div className="grid grid-cols-3 gap-6">
            <Card>
              <CardContent className="p-6">
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Balance</p>
                <p className={cn("text-3xl font-bold tracking-tight", bot?.balanceUsdt == null && "text-muted-foreground")}>
                  {bot?.balanceUsdt == null ? "—" : formatCurrency(bot.balanceUsdt)}
                </p>
                {bot?.balanceUsdt != null && (
                  <p className="text-[10px] font-mono text-muted-foreground mt-1 uppercase">USDT · {bot?.mode}</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Today's PnL</p>
                <p className={cn("text-3xl font-bold tracking-tight", statusUnknown ? "text-muted-foreground" : (bot?.dailyPnl ?? 0) >= 0 ? "text-success" : "text-destructive")}>
                  {statusUnknown ? "—" : formatCurrency(bot?.dailyPnl, "always")}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Win Rate</p>
                <p className={cn("text-3xl font-bold tracking-tight", statusUnknown ? "text-muted-foreground" : "text-primary")}>
                  {statusUnknown ? "—" : formatPercent(bot?.winRateToday)}
                </p>
              </CardContent>
            </Card>
          </div>
          <div className="grid grid-cols-2 gap-6">
            <Card>
              <CardContent className="p-6">
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Open Positions</p>
                <p className={cn("text-3xl font-bold tracking-tight", statusUnknown && "text-muted-foreground")}>
                  {statusUnknown ? "—" : (bot?.openPositions ?? 0)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Total Trades</p>
                <p className={cn("text-3xl font-bold tracking-tight", statusUnknown && "text-muted-foreground")}>
                  {statusUnknown ? "—" : (bot?.totalTradesToday ?? 0)}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Why is / isn't it trading — exact blocking condition */}
      <BlockingBanner />

      {/* Verification: live market data + full strategy decision pipeline */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <MarketMonitor />
        <DecisionPanel />
      </div>

      {/* Main Content Area */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        
        {/* Scanner Table */}
        <Card className="xl:col-span-2 flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between py-4 border-b border-border/50">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <CardTitle className="text-sm font-mono tracking-wider uppercase">Live Market Scanner</CardTitle>
            </div>
            <div className="text-xs text-muted-foreground font-mono flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
              </span>
              Scanning {scanner?.length || 0} pairs
            </div>
          </CardHeader>
          <div className="overflow-auto flex-1">
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
        </Card>

        {/* Open Positions */}
        <Card className="flex flex-col">
          <CardHeader className="py-4 border-b border-border/50">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              <CardTitle className="text-sm font-mono tracking-wider uppercase">Open Positions</CardTitle>
            </div>
          </CardHeader>
          <div className="overflow-auto p-0 flex-1">
            {trades?.map(trade => {
              const isProfit = (trade.pnl ?? 0) >= 0;
              return (
                <div key={trade.id} className="border-b border-border/50 p-4 hover:bg-muted/30 transition-colors">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-lg">{trade.symbol}</span>
                      <Badge variant={trade.side === 'buy' ? 'success' : 'destructive'} className="h-5 px-1.5 text-[10px]">
                        {trade.side}
                      </Badge>
                    </div>
                    <div className={cn("text-right font-mono font-bold", isProfit ? "text-success" : "text-destructive")}>
                      <div className="flex items-center justify-end gap-1">
                        {isProfit ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                        {formatCurrency(trade.pnl, "always")}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono text-muted-foreground mt-3">
                    <div>
                      <span className="block opacity-50 uppercase mb-0.5">Entry Price</span>
                      <span className="text-foreground">{formatNumber(trade.entryPrice, 4)}</span>
                    </div>
                    <div className="text-right">
                      <span className="block opacity-50 uppercase mb-0.5">Size</span>
                      <span className="text-foreground">{formatNumber(trade.quantity, 4)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {tradesError && (
              <div className="p-8 text-center text-destructive flex flex-col items-center justify-center h-full">
                <WifiOff className="h-8 w-8 mb-3 opacity-50" />
                <p className="font-mono text-sm uppercase tracking-wider">Unable to load positions</p>
                <p className="text-xs text-muted-foreground mt-1 normal-case">Open positions may still exist — check the exchange directly.</p>
              </div>
            )}
            {!tradesError && tradesLoading && (
              <div className="p-8 text-center text-muted-foreground flex flex-col items-center justify-center h-full">
                <p className="font-mono text-sm uppercase tracking-wider">Loading positions…</p>
              </div>
            )}
            {!tradesError && !tradesLoading && (!trades || trades.length === 0) && (
              <div className="p-8 text-center text-muted-foreground flex flex-col items-center justify-center h-full">
                <AlertTriangle className="h-8 w-8 mb-3 opacity-20" />
                <p className="font-mono text-sm uppercase tracking-wider">No active positions</p>
              </div>
            )}
          </div>
        </Card>

      </div>
    </div>
  );
}

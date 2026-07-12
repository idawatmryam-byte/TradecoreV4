import { useGetTrades, getGetTradesQueryKey, type GetTradesStatus } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Table, TableHeader, TableRow, TableHead, TableBody, TableCell, Badge, Button } from "@/components/ui";
import { formatCurrency, formatNumber, formatDate } from "@/lib/utils";
import { History, ArrowUpRight, ArrowDownRight, Filter, WifiOff } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function Trades() {
  const [filter, setFilter] = useState<GetTradesStatus | undefined>(undefined);
  
  const { data: trades, isLoading, isError } = useGetTrades(
    { status: filter, limit: 100 },
    { query: { refetchInterval: 10000, queryKey: getGetTradesQueryKey({ status: filter, limit: 100 }) } }
  );

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <History className="h-6 w-6 text-primary" /> Trade Log
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Complete history of all executed algorithmic trades.</p>
        </div>

        <div className="flex items-center gap-2 bg-card p-1 rounded-md border">
          <Filter className="h-4 w-4 text-muted-foreground ml-2 mr-1" />
          <Button 
            variant={filter === undefined ? "secondary" : "ghost"} 
            size="sm" 
            onClick={() => setFilter(undefined)}
            className="text-xs uppercase tracking-wider font-mono h-7"
          >
            All
          </Button>
          <Button 
            variant={filter === 'open' ? "secondary" : "ghost"} 
            size="sm" 
            onClick={() => setFilter('open')}
            className="text-xs uppercase tracking-wider font-mono h-7"
          >
            Open
          </Button>
          <Button 
            variant={filter === 'closed' ? "secondary" : "ghost"} 
            size="sm" 
            onClick={() => setFilter('closed')}
            className="text-xs uppercase tracking-wider font-mono h-7"
          >
            Closed
          </Button>
          <Button 
            variant={filter === 'stopped' ? "secondary" : "ghost"} 
            size="sm" 
            onClick={() => setFilter('stopped')}
            className="text-xs uppercase tracking-wider font-mono h-7"
          >
            Stopped
          </Button>
        </div>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <Table>
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {!isError && !isLoading && trades?.map((trade) => {
                const isClosed = trade.status !== 'open';
                const isProfit = (trade.pnl ?? 0) >= 0;

                return (
                  <TableRow key={trade.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(trade.entryTime)}
                    </TableCell>
                    <TableCell className="font-bold">{trade.symbol}</TableCell>
                    <TableCell>
                      <span className={cn(
                        "font-mono text-xs font-bold uppercase tracking-widest",
                        trade.side === 'buy' ? "text-success" : "text-destructive"
                      )}>
                        {trade.side}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <div>{formatNumber(trade.entryPrice, 4)}</div>
                      {trade.exitPrice && (
                        <div className="text-muted-foreground flex items-center gap-1 mt-0.5">
                          <span className="opacity-50">→</span> {formatNumber(trade.exitPrice, 4)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{formatNumber(trade.quantity, 4)}</TableCell>
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
                    <TableCell className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                      {trade.exitReason?.replace('_', ' ') || '-'}
                    </TableCell>
                  </TableRow>
                );
              })}
              {isError && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-destructive font-mono text-sm uppercase tracking-wider">
                    <div className="flex items-center justify-center gap-2">
                      <WifiOff className="h-4 w-4" /> Unable to load trades — check API connectivity.
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!isError && isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-muted-foreground font-mono text-sm uppercase tracking-wider">
                    Loading trades…
                  </TableCell>
                </TableRow>
              )}
              {!isError && !isLoading && (!trades || trades.length === 0) && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-muted-foreground font-mono text-sm uppercase tracking-wider">
                    No trades found matching criteria.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}

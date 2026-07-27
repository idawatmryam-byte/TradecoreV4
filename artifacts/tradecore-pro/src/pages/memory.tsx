import { useGetBlacklist, useGetToxicHours, getGetBlacklistQueryKey, getGetToxicHoursQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Table, TableHeader, TableRow, TableHead, TableBody, TableCell, Badge } from "@/components/ui";
import { formatCurrency, formatPercent, formatDate } from "@/lib/utils";
import { KnowledgePanel } from "@/components/knowledge/knowledge-panel";
import { MemoryInfluencePanel } from "@/components/knowledge/memory-influence-panel";
import { PageHeader } from "@/components/patterns";
import { BrainCircuit, ShieldBan, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export function Memory() {
  const { data: blacklist } = useGetBlacklist({ query: { queryKey: getGetBlacklistQueryKey() } });
  const { data: toxicHours } = useGetToxicHours({ query: { queryKey: getGetToxicHoursQueryKey() } });

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        icon={BrainCircuit}
        title="Learning"
        description="What the engine has worked out about its own record — the symbols and hours it has quarantined, what your closed trades support saying, and whether any of it is allowed to change what it does next."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        <Card className="border-destructive/30 relative overflow-hidden">
          <div className="absolute top-0 right-0 p-32 bg-destructive/5 blur-3xl rounded-full pointer-events-none"></div>
          <CardHeader>
            <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2 text-destructive">
              <ShieldBan className="h-4 w-4" /> Asset Blacklist
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Symbol</TableHead>
                  <TableHead>Win Rate</TableHead>
                  <TableHead>Trades</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {blacklist?.map((entry) => (
                  <TableRow key={entry.symbol}>
                    <TableCell className="font-bold text-destructive">{entry.symbol}</TableCell>
                    <TableCell className="font-mono">{formatPercent(entry.winRate * 100)}</TableCell>
                    <TableCell className="font-mono">{entry.tradeCount}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {formatDate(entry.expiresAt)}
                    </TableCell>
                  </TableRow>
                ))}
                {(!blacklist || blacklist.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-8 text-muted-foreground font-mono text-sm uppercase tracking-wider">
                      Memory Core clear. No assets quarantined.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="border-warning/30 relative overflow-hidden">
          <div className="absolute top-0 right-0 p-32 bg-warning/5 blur-3xl rounded-full pointer-events-none"></div>
          <CardHeader>
            <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2 text-warning">
              <Clock className="h-4 w-4" /> Toxic Timeframes (UTC)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Hour</TableHead>
                  <TableHead className="text-right">Cumulative PnL</TableHead>
                  <TableHead>Sample Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {toxicHours?.map((entry) => (
                  <TableRow key={entry.hour}>
                    <TableCell className="font-mono font-bold text-warning">{entry.hour}:00 - {entry.hour}:59</TableCell>
                    <TableCell className="text-right font-mono text-destructive">
                      {formatCurrency(entry.cumulativePnl, "always")}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {entry.tradeCount} trades
                    </TableCell>
                  </TableRow>
                ))}
                {(!toxicHours || toxicHours.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center py-8 text-muted-foreground font-mono text-sm uppercase tracking-wider">
                      Timeframe efficiency nominal. No blocks.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

      </div>

      {/* What the record supports saying — and, as prominently, what it doesn't. */}
      <KnowledgePanel />

      {/* The one control that lets that record change what the engine does. */}
      <MemoryInfluencePanel />
    </div>
  );
}

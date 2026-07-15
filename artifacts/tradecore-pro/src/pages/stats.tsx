import { useGetStatsSummary, useGetHourlyStats, useGetDailyReport, getGetStatsSummaryQueryKey, getGetHourlyStatsQueryKey, getGetDailyReportQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatPercent, formatNumber } from "@/lib/utils";
import { BarChart2, Flame, TrendingDown, Target, Zap, FileText, Download } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, Cell as PieCell } from 'recharts';
import { cn } from "@/lib/utils";
import { useState } from "react";

// ---------------------------------------------------------------------------
// Daily trade report — same data the engine pushes to the alert webhook at
// UTC midnight, on demand for any day, with a CSV download.
// ---------------------------------------------------------------------------
function DailyReportCard() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const params = { date };
  const { data: report, isLoading } = useGetDailyReport(params, {
    query: { queryKey: getGetDailyReportQueryKey(params) },
  });

  function downloadCsv() {
    if (!report) return;
    const header = "id,symbol,side,strategy,entryTime,exitTime,entryPrice,exitPrice,quantity,pnl,exitReason";
    const rows = report.trades.map((t) =>
      [t.id, t.symbol, t.side, t.strategyName ?? "", t.entryTime, t.exitTime ?? "", t.entryPrice, t.exitPrice ?? "", t.quantity, t.pnl ?? "", t.exitReason ?? ""].join(","),
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tradecore-daily-report-${report.date}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const s = report?.summary;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" /> Daily Trade Report
        </CardTitle>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="bg-background border border-border rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Button variant="outline" size="sm" onClick={downloadCsv} disabled={!report || report.trades.length === 0} className="gap-1">
            <Download className="h-3 w-3" /> CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !s ? (
          <p className="text-xs font-mono text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div>
                <p className="text-[10px] font-mono text-muted-foreground uppercase">P&L</p>
                <p className={cn("text-xl font-bold", s.totalPnl >= 0 ? "text-success" : "text-destructive")}>{formatCurrency(s.totalPnl, "always")}</p>
              </div>
              <div>
                <p className="text-[10px] font-mono text-muted-foreground uppercase">Trades</p>
                <p className="text-xl font-bold">{s.totalTrades} <span className="text-xs text-muted-foreground">({s.wins}W/{s.losses}L)</span></p>
              </div>
              <div>
                <p className="text-[10px] font-mono text-muted-foreground uppercase">Win rate</p>
                <p className="text-xl font-bold text-primary">{(s.winRate * 100).toFixed(0)}%</p>
              </div>
              <div>
                <p className="text-[10px] font-mono text-muted-foreground uppercase">Fees</p>
                <p className="text-xl font-bold">{formatCurrency(s.totalFeesUsdt)}</p>
              </div>
              <div>
                <p className="text-[10px] font-mono text-muted-foreground uppercase">Open now</p>
                <p className="text-xl font-bold">{s.openPositions}</p>
              </div>
            </div>

            {s.totalTrades === 0 ? (
              <p className="text-xs font-mono text-muted-foreground">No trades closed on {report!.date} (UTC).</p>
            ) : (
              <>
                <div className="text-xs font-mono text-muted-foreground">
                  exits — {Object.entries(report!.exitReasons).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border">
                        <th className="text-left py-1 pr-3">Strategy</th>
                        <th className="text-right py-1 pr-3">Trades</th>
                        <th className="text-right py-1 pr-3">Wins</th>
                        <th className="text-right py-1">P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report!.byStrategy.sort((a, b) => b.pnl - a.pnl).map((row) => (
                        <tr key={row.strategyName} className="border-b border-border/40">
                          <td className="py-1 pr-3">{row.strategyName}</td>
                          <td className="text-right py-1 pr-3">{row.trades}</td>
                          <td className="text-right py-1 pr-3">{row.wins}</td>
                          <td className={cn("text-right py-1", row.pnl >= 0 ? "text-success" : "text-destructive")}>{formatCurrency(row.pnl, "always")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <p className="text-[10px] text-muted-foreground">
              This report is also pushed automatically to your alert webhook at UTC midnight (Configuration → Alert Webhook URL).
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function Stats() {
  const { data: summary } = useGetStatsSummary({ query: { queryKey: getGetStatsSummaryQueryKey() } });
  const { data: hourly } = useGetHourlyStats({ query: { queryKey: getGetHourlyStatsQueryKey() } });

  const isProfit = (summary?.totalPnl ?? 0) >= 0;

  // summary.winRate is a 0–1 fraction (wins/total from the stats route) — the
  // old code treated it as 0–100, which skewed the pie to ~all-losses.
  const pieData = summary ? [
    { name: 'Wins', value: summary.winRate * summary.totalTrades },
    { name: 'Losses', value: (1 - summary.winRate) * summary.totalTrades }
  ] : [];
  const PIE_COLORS = ['hsl(140, 100%, 45%)', 'hsl(350, 100%, 60%)'];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <BarChart2 className="h-6 w-6 text-primary" /> Performance Analytics
        </h1>
        <p className="text-muted-foreground text-sm mt-1">Deep dive into historical edge and execution metrics.</p>
      </div>

      <DailyReportCard />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card className="bg-card">
          <CardContent className="p-6">
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Net PnL</p>
            <p className={cn("text-3xl font-bold tracking-tight", isProfit ? "text-success" : "text-destructive")}>
              {formatCurrency(summary?.totalPnl, "always")}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-6">
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Win Rate</p>
            <p className="text-3xl font-bold tracking-tight text-primary">
              {formatPercent((summary?.winRate ?? 0) * 100)}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-6">
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
              <TrendingDown className="h-3 w-3 text-destructive" /> Max Drawdown
            </p>
            {/* maxDrawdown is a non-negative magnitude; render it as a loss
                (−$X) rather than "always" which prints a misleading "+$X". */}
            <p className="text-3xl font-bold tracking-tight text-destructive">
              {formatCurrency(summary?.maxDrawdown ? -summary.maxDrawdown : summary?.maxDrawdown)}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-6">
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
              <Flame className="h-3 w-3 text-warning" /> Current Streak
            </p>
            <p className="text-3xl font-bold tracking-tight flex items-baseline gap-2">
              {summary?.streakCurrent ?? 0}
              {summary?.streakType !== 'none' && (
                <span className={cn("text-sm font-mono uppercase tracking-wider", summary?.streakType === 'win' ? "text-success" : "text-destructive")}>
                  {summary?.streakType}s
                </span>
              )}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-mono tracking-wider uppercase">Hourly Execution Heatmap (UTC)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourly || []} margin={{ top: 20, right: 0, left: -20, bottom: 0 }}>
                  <XAxis dataKey="hour" tickFormatter={(v) => `${v}:00`} stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} />
                  <Tooltip 
                    cursor={{ fill: 'hsl(var(--muted)/0.5)' }}
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                    labelFormatter={(v) => `${v}:00 UTC`}
                    formatter={(value: number) => [formatCurrency(value), "PnL"]}
                  />
                  <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                    {hourly?.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.isToxic ? 'hsl(var(--destructive))' : entry.pnl >= 0 ? 'hsl(var(--success))' : 'hsl(var(--warning))'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 flex items-center gap-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">
              <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-sm bg-success"></div> Profitable</div>
              <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-sm bg-warning"></div> Loss</div>
              <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-sm bg-destructive"></div> Toxic Hour Blocked</div>
            </div>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="text-sm font-mono tracking-wider uppercase">Win / Loss Ratio</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col justify-center items-center pb-8">
            <div className="h-[200px] w-full relative">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                    stroke="none"
                  >
                    {pieData.map((entry, index) => (
                      <PieCell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                    formatter={(value: number) => [formatNumber(value, 0), "Trades"]}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex items-center justify-center flex-col pointer-events-none">
                <span className="text-3xl font-bold text-foreground">{formatPercent((summary?.winRate ?? 0) * 100)}</span>
                <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mt-1">Win Rate</span>
              </div>
            </div>
            
            <div className="w-full space-y-4 mt-6">
              <div className="flex justify-between items-center p-3 rounded-md bg-muted/30 border">
                <div className="flex items-center gap-2">
                  <Target className="h-4 w-4 text-primary" />
                  <span className="text-xs font-mono uppercase tracking-wider">Avg Confidence</span>
                </div>
                <span className="font-bold">{formatNumber(summary?.avgConfidence, 1)}</span>
              </div>
              <div className="flex justify-between items-center p-3 rounded-md bg-muted/30 border">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-primary" />
                  <span className="text-xs font-mono uppercase tracking-wider">Total Trades</span>
                </div>
                <span className="font-bold">{summary?.totalTrades}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

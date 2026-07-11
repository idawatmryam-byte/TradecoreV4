import { useGetStatsSummary, useGetDailyStats, useGetHourlyStats, getGetStatsSummaryQueryKey, getGetDailyStatsQueryKey, getGetHourlyStatsQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui";
import { formatCurrency, formatPercent, formatNumber } from "@/lib/utils";
import { BarChart2, Flame, TrendingDown, Target, Zap } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, Cell as PieCell } from 'recharts';
import { cn } from "@/lib/utils";

export function Stats() {
  const { data: summary } = useGetStatsSummary({ query: { queryKey: getGetStatsSummaryQueryKey() } });
  const { data: daily } = useGetDailyStats({ query: { queryKey: getGetDailyStatsQueryKey() } });
  const { data: hourly } = useGetHourlyStats({ query: { queryKey: getGetHourlyStatsQueryKey() } });

  const isProfit = (summary?.totalPnl ?? 0) >= 0;

  const pieData = summary ? [
    { name: 'Wins', value: summary.winRate * summary.totalTrades / 100 },
    { name: 'Losses', value: (100 - summary.winRate) * summary.totalTrades / 100 }
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
              {formatPercent(summary?.winRate)}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-6">
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
              <TrendingDown className="h-3 w-3 text-destructive" /> Max Drawdown
            </p>
            <p className="text-3xl font-bold tracking-tight text-destructive">
              {formatCurrency(summary?.maxDrawdown, "always")}
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
                <span className="text-3xl font-bold text-foreground">{formatPercent(summary?.winRate)}</span>
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

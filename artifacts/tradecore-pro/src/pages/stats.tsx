import { useGetStatsSummary, useGetHourlyStats, useGetDailyReport, getGetStatsSummaryQueryKey, getGetHourlyStatsQueryKey, getGetDailyReportQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatPercent, formatNumber } from "@/lib/utils";
import { BarChart2, Flame, TrendingDown, Target, Zap, FileText, Download, Microscope, AlertTriangle, Info, CheckCircle2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, Cell as PieCell } from 'recharts';
import { cn } from "@/lib/utils";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSection, sectionHeaders } from "@/lib/section";

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

// ---------------------------------------------------------------------------
// Edge Forensics — "where does the losing come from" (GET /reports/edge-forensics)
// ---------------------------------------------------------------------------
interface ForensicCell {
  key: string; label: string; trades: number; wins: number; losses: number; scratches: number;
  totalPnl: number; adjustedWinRate: number | null; avgPnl: number; avgR: number | null;
}
interface ForensicsData {
  totalTrades: number; wins: number; losses: number; scratches: number;
  rawWinRate: number | null; adjustedWinRate: number | null;
  totalPnl: number; totalFees: number; grossPnl: number;
  avgWin: number | null; avgLoss: number | null; expectancyPerTrade: number | null;
  byExitReason: ForensicCell[]; byStrategy: ForensicCell[]; bySymbol: ForensicCell[]; byHourUtc: ForensicCell[];
  rDistribution: Array<{ bucket: string; count: number }>;
  verdicts: Array<{ severity: "critical" | "warning" | "info"; title: string; detail: string }>;
  noiseFlags: Array<{ strategyId: string; symbol: string; impliedStopPct: number; atrPct: number; severity: string }>;
  engineOffline: boolean;
}

function CellTable({ title, cells }: { title: string; cells: ForensicCell[] }) {
  if (cells.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">{title}</p>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left px-2 py-1.5 font-normal">Cell</th>
              <th className="text-right px-2 py-1.5 font-normal">Trades</th>
              <th className="text-right px-2 py-1.5 font-normal">W / L / scratch</th>
              <th className="text-right px-2 py-1.5 font-normal">Adj. WR</th>
              <th className="text-right px-2 py-1.5 font-normal">Avg R</th>
              <th className="text-right px-2 py-1.5 font-normal">Net P&L</th>
            </tr>
          </thead>
          <tbody>
            {cells.map((c) => (
              <tr key={c.key} className="border-b border-border/50 last:border-0">
                <td className="px-2 py-1.5">{c.label}</td>
                <td className="text-right px-2 py-1.5">{c.trades}</td>
                <td className="text-right px-2 py-1.5 text-muted-foreground">{c.wins} / {c.losses} / {c.scratches}</td>
                <td className="text-right px-2 py-1.5">{c.adjustedWinRate != null ? `${(c.adjustedWinRate * 100).toFixed(0)}%` : "—"}</td>
                <td className="text-right px-2 py-1.5">{c.avgR ?? "—"}</td>
                <td className={cn("text-right px-2 py-1.5 font-bold", c.totalPnl >= 0 ? "text-success" : "text-destructive")}>
                  {c.totalPnl >= 0 ? "+" : ""}{c.totalPnl.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EdgeForensicsCard() {
  const { section } = useSection();
  const [open, setOpen] = useState(true);
  const { data, isLoading } = useQuery<ForensicsData>({
    queryKey: ["edge-forensics", section],
    refetchInterval: 60_000,
    queryFn: async () => {
      const res = await fetch("/api/reports/edge-forensics", { credentials: "same-origin", headers: sectionHeaders() });
      if (!res.ok) throw new Error("forensics fetch failed");
      return res.json();
    },
  });

  const sevIcon = {
    critical: <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />,
    warning: <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />,
    info: <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />,
  } as const;
  const sevBorder = {
    critical: "border-destructive/40 bg-destructive/5",
    warning: "border-warning/40 bg-warning/5",
    info: "border-primary/30 bg-primary/5",
  } as const;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
          <Microscope className="h-4 w-4 text-primary" /> Edge Forensics
          <span className="text-muted-foreground normal-case tracking-normal font-normal">— where the losses actually come from</span>
        </CardTitle>
        <span className="text-xs font-mono text-muted-foreground">{open ? "hide" : "show"}</span>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          {isLoading || !data ? (
            <p className="text-xs font-mono text-muted-foreground">Analyzing closed trades…</p>
          ) : data.totalTrades === 0 ? (
            <p className="text-xs font-mono text-muted-foreground">No closed live trades in this section yet — forensics start once trades close.</p>
          ) : (
            <>
              {/* The honest headline: raw vs scratch-adjusted win rate. */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div className="rounded border border-border p-3">
                  <p className="text-[10px] font-mono text-muted-foreground uppercase">Raw win rate</p>
                  <p className="text-xl font-bold">{data.rawWinRate != null ? `${(data.rawWinRate * 100).toFixed(0)}%` : "—"}</p>
                  <p className="text-[10px] text-muted-foreground">counts scratches as losses</p>
                </div>
                <div className="rounded border border-primary/40 bg-primary/5 p-3">
                  <p className="text-[10px] font-mono text-muted-foreground uppercase">Adjusted win rate</p>
                  <p className="text-xl font-bold text-primary">{data.adjustedWinRate != null ? `${(data.adjustedWinRate * 100).toFixed(0)}%` : "—"}</p>
                  <p className="text-[10px] text-muted-foreground">scratches excluded — the honest number</p>
                </div>
                <div className="rounded border border-border p-3">
                  <p className="text-[10px] font-mono text-muted-foreground uppercase">W / L / Scratch</p>
                  <p className="text-xl font-bold">{data.wins} / {data.losses} / {data.scratches}</p>
                  <p className="text-[10px] text-muted-foreground">{data.totalTrades} closed trades</p>
                </div>
                <div className="rounded border border-border p-3">
                  <p className="text-[10px] font-mono text-muted-foreground uppercase">Expectancy / decided trade</p>
                  <p className={cn("text-xl font-bold", (data.expectancyPerTrade ?? 0) >= 0 ? "text-success" : "text-destructive")}>
                    {data.expectancyPerTrade != null ? `$${data.expectancyPerTrade.toFixed(2)}` : "—"}
                  </p>
                </div>
                <div className="rounded border border-border p-3">
                  <p className="text-[10px] font-mono text-muted-foreground uppercase">Fees paid</p>
                  <p className="text-xl font-bold">${data.totalFees.toFixed(2)}</p>
                  <p className="text-[10px] text-muted-foreground">gross {data.grossPnl >= 0 ? "+" : ""}{data.grossPnl.toFixed(2)} → net {data.totalPnl >= 0 ? "+" : ""}{data.totalPnl.toFixed(2)}</p>
                </div>
              </div>

              {/* The convictions. */}
              {data.verdicts.length > 0 && (
                <div className="space-y-2">
                  {data.verdicts.map((v, i) => (
                    <div key={i} className={cn("flex gap-2.5 rounded border p-3", sevBorder[v.severity])}>
                      {sevIcon[v.severity]}
                      <div className="min-w-0">
                        <p className="text-xs font-semibold">{v.title}</p>
                        <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{v.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {data.engineOffline && (
                <p className="text-[11px] font-mono text-muted-foreground flex items-center gap-1.5">
                  <Info className="h-3 w-3" /> Noise-floor audit needs the engine running (live ATR readings) — start the engine and reload.
                </p>
              )}
              {data.noiseFlags.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">Stop-vs-noise audit (live ATR)</p>
                  <div className="flex flex-wrap gap-1.5">
                    {data.noiseFlags.map((f, i) => (
                      <span key={i} className={cn("px-2 py-1 rounded text-[11px] font-mono border", f.severity === "inside_noise" ? "border-destructive/50 text-destructive bg-destructive/10" : "border-warning/50 text-warning bg-warning/10")}>
                        {f.strategyId} × {f.symbol}: stop {f.impliedStopPct}% vs ATR {f.atrPct}%
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <CellTable title="By exit reason (most bleeding first)" cells={data.byExitReason} />
                <CellTable title="By strategy" cells={data.byStrategy} />
                <CellTable title="By symbol" cells={data.bySymbol} />
                <CellTable title="By entry hour (UTC)" cells={data.byHourUtc.filter((c) => c.trades > 0)} />
              </div>

              {data.rDistribution.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">Realized R-multiple distribution</p>
                  <div className="flex flex-wrap gap-1.5">
                    {data.rDistribution.map((b) => (
                      <span key={b.bucket} className="px-2 py-1 rounded text-[11px] font-mono border border-border text-muted-foreground">
                        {b.bucket}: <span className="text-foreground font-bold">{b.count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary" />
                <span>
                  How to read this: a <strong>scratch</strong> is a break-even exit (stop moved to entry after TP1) or a wash within ±10% of planned risk —
                  the market didn't beat the trade, it just didn't go anywhere. Cells with ≥5 trades and negative P&L are candidates for the
                  selection filter: stop trading where you measurably lose, keep trading where you win.
                </span>
              </p>
            </>
          )}
        </CardContent>
      )}
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

      {/* The diagnosis layer: decomposes the win-rate number into named,
          dollar-quantified leaks (scratches, noise-stops, negative cells). */}
      <EdgeForensicsCard />

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

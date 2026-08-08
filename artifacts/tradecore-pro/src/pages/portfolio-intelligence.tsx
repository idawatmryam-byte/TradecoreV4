import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  BriefcaseBusiness,
  Eye,
  RefreshCw,
  ShieldCheck,
  TrendingDown,
  WalletCards,
  WifiOff,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { EmptyState, PageHeader } from "@/components/patterns";
import { sectionHeaders, useSection } from "@/lib/section";
import { cn } from "@/lib/utils";

type DataStatus = "healthy" | "degraded" | "blocked";
type Disposition = "SHADOW_ALLOCATED" | "WAIT_FOR_TRIGGER" | "OBSERVE" | "REJECTED";

interface Projection {
  schemaVersion: "1.0.0";
  portfolioVersion: string;
  mode: "shadow";
  cannotExecute: true;
  projectionId: string;
  fingerprint: string;
  generatedAt: string;
  sourceScanTimestamp: string | null;
  dataStatus: DataStatus;
  dataIssues: string[];
  policy: {
    riskPolicyVersion: string;
    maxOpenPositions: number;
    maxPortfolioRiskFraction: number;
    maxStrategyRiskFraction: number;
    maxCorrelatedNotionalFraction: number;
    unknownCorrelationPolicy: "allow" | "block";
  };
  context: {
    currency: string;
    equity: number;
    availableBalance: number;
    openPositionCount: number;
    remainingStopRisk: number;
    grossExposure: number;
    netExposure: number;
    drawdownFraction: number;
    reservedRisk: number;
    correlationState: "known" | "partial" | "unknown";
    correlationClusters: Array<{ clusterId: string; symbols: string[]; exposure: number }>;
  };
  riskUsage: {
    maximumStopRisk: number;
    openStopRisk: number;
    initiallyReservedRisk: number;
    shadowReservedRisk: number;
    remainingRisk: number;
    drawdownScale: number;
    openPositions: number;
    shadowAllocatedPositions: number;
    remainingPositionSlots: number;
  };
  opportunities: Array<{
    rank: number;
    decisionId: string;
    sourceFingerprint: string;
    symbol: string;
    side: "long" | "short" | null;
    action: "ENTER_NOW" | "WAIT_FOR_TRIGGER" | "OBSERVE" | "REJECT" | "REDUCE" | "EXIT";
    strategyId: string | null;
    strategyName: string | null;
    dataTimestamp: string;
    expiresAt: string;
    score: number;
    estimatedNetR: null;
    netRewardRisk: number | null;
    uncertainty: number;
    requestedRisk: number;
    requestedNotional: number;
    allocatedRisk: number;
    allocatedNotional: number;
    allocatedQuantity: number;
    allocationFraction: number;
    disposition: Disposition;
    reasonCodes: string[];
    explanation: string;
    correlationUnknownWith: string[];
    reinforcingClusterSymbols: string[];
  }>;
  retainedCash: {
    amount: number;
    fractionOfAvailableBalance: number;
    reasonCodes: string[];
    explanation: string;
  };
}

function money(value: number, currency: string): string {
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function readable(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function RiskBar({ used, maximum }: { used: number; maximum: number }) {
  const ratio = maximum > 0 ? Math.min(1, used / maximum) : 0;
  return (
    <div
      className="h-2 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label="Stop-risk budget used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
    >
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

const dispositionStyle: Record<Disposition, string> = {
  SHADOW_ALLOCATED: "border-success/40 bg-success/10 text-success",
  WAIT_FOR_TRIGGER: "border-primary/40 bg-primary/10 text-primary",
  OBSERVE: "border-border bg-muted/40 text-muted-foreground",
  REJECTED: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function PortfolioIntelligence() {
  const { section } = useSection();
  const [shockPercent, setShockPercent] = useState("-5");
  const query = useQuery<Projection>({
    queryKey: ["portfolio-intelligence", section],
    queryFn: async () => {
      const response = await fetch("/api/intelligence/portfolio", {
        credentials: "same-origin",
        headers: sectionHeaders(),
      });
      if (!response.ok) throw new Error(`Portfolio Intelligence request failed (${response.status})`);
      return response.json() as Promise<Projection>;
    },
    refetchInterval: 10_000,
  });

  const projection = query.data;
  const strategyAllocations = useMemo(() => {
    const totals = new Map<string, number>();
    for (const item of projection?.opportunities ?? []) {
      if (item.allocatedRisk <= 0) continue;
      const key = item.strategyName ?? item.strategyId ?? "Unassigned";
      totals.set(key, (totals.get(key) ?? 0) + item.allocatedRisk);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [projection]);

  const shock = Number(shockPercent);
  const scenarioPnl = projection && Number.isFinite(shock)
    ? projection.context.netExposure * shock / 100
    : null;
  const riskUsed = projection
    ? projection.riskUsage.openStopRisk
      + projection.riskUsage.initiallyReservedRisk
      + projection.riskUsage.shadowReservedRisk
    : 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        icon={BriefcaseBusiness}
        title="Portfolio Intelligence"
        description="Rank the complete Shadow opportunity set, then reserve bounded risk across the portfolio."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/trades" className="inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">
              Trade log
            </Link>
            <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}>
              <RefreshCw className={cn("mr-2 h-3.5 w-3.5", query.isFetching && "animate-spin")} />
              Refresh
            </Button>
          </div>
        }
      />

      <div role="status" className="flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/10 p-4">
        <Eye className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div>
          <p className="font-semibold text-primary">Shadow — cannot execute</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Allocations are research projections. They cannot place orders, reserve real funds, or change Brain V0, Demo, Co-Pilot, or Live behavior.
          </p>
        </div>
      </div>

      {query.isLoading && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground" role="status">
            Building the latest same-scan portfolio projection…
          </CardContent>
        </Card>
      )}

      {query.isError && (
        <Card>
          <EmptyState
            icon={WifiOff}
            title="Portfolio projection is unavailable"
            description="The API could not construct this read-only view. Trading behavior was not changed."
            action={{ label: "Try again", onClick: () => query.refetch() }}
          />
        </Card>
      )}

      {projection && (
        <>
          <div
            role={projection.dataStatus === "blocked" ? "alert" : "status"}
            className={cn(
              "flex items-start gap-3 rounded-lg border p-4",
              projection.dataStatus === "healthy" && "border-success/40 bg-success/10",
              projection.dataStatus === "degraded" && "border-yellow-500/40 bg-yellow-500/10",
              projection.dataStatus === "blocked" && "border-destructive/40 bg-destructive/10",
            )}
          >
            {projection.dataStatus === "healthy"
              ? <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" />
              : <AlertTriangle className={cn("mt-0.5 h-5 w-5 shrink-0", projection.dataStatus === "blocked" ? "text-destructive" : "text-yellow-400")} />}
            <div>
              <p className="font-semibold">{readable(projection.dataStatus)} portfolio data</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {projection.dataIssues.length === 0
                  ? "The current projection passed all available data checks."
                  : projection.dataIssues.join(" ")}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Version {projection.portfolioVersion} · generated {new Date(projection.generatedAt).toLocaleString()} · correlation {projection.context.correlationState}
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Stop risk budget"
              value={money(projection.riskUsage.maximumStopRisk, projection.context.currency)}
              detail={`${money(riskUsed, projection.context.currency)} used including Shadow`}
            />
            <Metric
              label="Shadow reserved"
              value={money(projection.riskUsage.shadowReservedRisk, projection.context.currency)}
              detail={`${projection.riskUsage.shadowAllocatedPositions} hypothetical position(s)`}
            />
            <Metric
              label="Remaining budget"
              value={money(projection.riskUsage.remainingRisk, projection.context.currency)}
              detail={`${projection.riskUsage.remainingPositionSlots} position slot(s) remain`}
            />
            <Metric
              label="Retained cash"
              value={money(projection.retainedCash.amount, projection.context.currency)}
              detail={`${percent(projection.retainedCash.fractionOfAvailableBalance)} remains untouched`}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Risk used versus available</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <RiskBar used={riskUsed} maximum={projection.riskUsage.maximumStopRisk} />
              <div className="grid gap-3 text-sm sm:grid-cols-3">
                <div><span className="text-muted-foreground">Open stop risk</span><p className="font-mono">{money(projection.riskUsage.openStopRisk, projection.context.currency)}</p></div>
                <div><span className="text-muted-foreground">Pre-reserved</span><p className="font-mono">{money(projection.riskUsage.initiallyReservedRisk, projection.context.currency)}</p></div>
                <div><span className="text-muted-foreground">Shadow reserved</span><p className="font-mono">{money(projection.riskUsage.shadowReservedRisk, projection.context.currency)}</p></div>
              </div>
              <p className="text-xs text-muted-foreground">
                Drawdown scale {percent(projection.riskUsage.drawdownScale)}. Shadow reservations are included sequentially so simultaneous candidates cannot reuse the same budget.
              </p>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Allocation by strategy</CardTitle></CardHeader>
              <CardContent>
                {strategyAllocations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No strategy received a Shadow allocation in this scan.</p>
                ) : (
                  <ul className="space-y-3">
                    {strategyAllocations.map(([strategy, risk]) => (
                      <li key={strategy} className="flex items-center justify-between gap-3 text-sm">
                        <span className="truncate">{strategy}</span>
                        <span className="font-mono">{money(risk, projection.context.currency)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Correlation clusters</CardTitle></CardHeader>
              <CardContent>
                {projection.context.correlationClusters.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No symbol exposure is available to cluster.</p>
                ) : (
                  <ul className="space-y-3">
                    {projection.context.correlationClusters.map((cluster) => (
                      <li key={cluster.clusterId} className="rounded-md border bg-muted/20 p-3">
                        <p className="text-sm font-medium">{cluster.symbols.join(", ")}</p>
                        <p className="mt-1 text-xs text-muted-foreground">Observed open exposure {money(cluster.exposure, projection.context.currency)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ranked opportunities</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {projection.opportunities.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  No complete Shadow council scan is available yet. Cash is retained by default.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table className="min-w-[1050px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Rank</TableHead>
                        <TableHead>Opportunity</TableHead>
                        <TableHead>Score / uncertainty</TableHead>
                        <TableHead>Net R estimate</TableHead>
                        <TableHead>Requested</TableHead>
                        <TableHead>Shadow allocation</TableHead>
                        <TableHead>Disposition</TableHead>
                        <TableHead>Why</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {projection.opportunities.map((item) => (
                        <TableRow key={item.decisionId}>
                          <TableCell className="font-mono">#{item.rank}</TableCell>
                          <TableCell>
                            <p className="font-semibold">{item.symbol} {item.side ?? "—"}</p>
                            <p className="text-xs text-muted-foreground">{item.strategyName ?? item.strategyId ?? "No strategy"} · {readable(item.action)}</p>
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {percent(item.score)}
                            <p className="text-xs text-muted-foreground">{percent(item.uncertainty)} uncertain</p>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-muted-foreground">Unavailable</span>
                            <p className="text-xs text-muted-foreground">Uncalibrated; plan R/R {item.netRewardRisk?.toFixed(2) ?? "—"}</p>
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {money(item.requestedRisk, projection.context.currency)}
                            <p className="text-xs text-muted-foreground">{money(item.requestedNotional, projection.context.currency)} notional</p>
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {money(item.allocatedRisk, projection.context.currency)}
                            <p className="text-xs text-muted-foreground">{percent(item.allocationFraction)} of request</p>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={dispositionStyle[item.disposition]}>
                              {readable(item.disposition)}
                            </Badge>
                          </TableCell>
                          <TableCell className="max-w-xs text-sm">
                            <p>{item.explanation}</p>
                            {item.reasonCodes.length > 0 && (
                              <p className="mt-1 text-xs text-muted-foreground">{item.reasonCodes.map(readable).join(" · ")}</p>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><WalletCards className="h-4 w-4" /> Why cash was retained</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm">{projection.retainedCash.explanation}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {projection.retainedCash.reasonCodes.map((code) => <Badge key={code} variant="secondary">{readable(code)}</Badge>)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><TrendingDown className="h-4 w-4" /> Exposure scenario</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="max-w-xs">
                  <Label htmlFor="portfolio-shock">Uniform market move (%)</Label>
                  <Input
                    id="portfolio-shock"
                    className="mt-1"
                    type="number"
                    step="0.5"
                    value={shockPercent}
                    onChange={(event) => setShockPercent(event.target.value)}
                  />
                </div>
                <p className="font-mono text-xl font-semibold">
                  {scenarioPnl == null ? "Enter a valid shock" : money(scenarioPnl, projection.context.currency)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Linear directional estimate from current net exposure only. It ignores gaps, nonlinear products, changing correlations, slippage, liquidity, and stop execution; it is not a guaranteed loss or profit.
                </p>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

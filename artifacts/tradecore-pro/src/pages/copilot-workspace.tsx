import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRecommendationWorkspace, getGetRecommendationWorkspaceQueryKey,
  useExecuteRecommendation, useRejectRecommendation, useModifyRecommendation,
  useGetConfig, getGetConfigQueryKey, getGetCopilotInboxQueryKey,
  type RevalidationCheck, type SimilarTrades as SimilarTradesType,
} from "@workspace/api-client-react";
import { Card, CardContent, Button, Badge, Input, Label } from "@/components/ui";
import { PositionChart } from "@/components/position-chart";
import { DecisionTimeline } from "@/components/decision-timeline";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import {
  ArrowLeft, ArrowUpRight, ArrowDownRight, CheckCircle2, XCircle, Ban, Clock,
  Loader2, Pencil, ShieldAlert, Lightbulb, PieChart, ListTree,
} from "lucide-react";

/**
 * Co-Pilot Workspace — the full picture behind ONE recommendation: the plan,
 * the chart with its levels drawn, the five-stage reasoning that produced it,
 * what taking it would do to the portfolio, and the actions to act on it.
 *
 * Everything here VISUALIZES data that already exists elsewhere in the
 * product — the TradePlan, the decision trace, the portfolio-risk numbers
 * Co-Pilot already re-checks on approval, and "Similar Historical Trades",
 * which is now a real feature-similarity search over the account's own closed
 * trades. That panel stays silent whenever its pool gate or similarity floor
 * is unmet, which on a young account is most of the time; a run of matches is
 * shown as a list of facts, and their win rate only once there are enough of
 * them to mean anything.
 */

const STATUS_META: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  created:    { label: "Awaiting you", className: "bg-primary/10 text-primary border-primary/40", icon: Clock },
  executed:   { label: "Executed",     className: "bg-success/15 text-success border-success/40", icon: CheckCircle2 },
  rejected:   { label: "Declined",     className: "bg-muted text-muted-foreground border-border", icon: XCircle },
  expired:    { label: "Expired",      className: "bg-muted text-muted-foreground border-border", icon: Clock },
  superseded: { label: "Superseded",   className: "bg-muted text-muted-foreground border-border", icon: Pencil },
  blocked:    { label: "Blocked",      className: "bg-destructive/10 text-destructive border-destructive/40", icon: Ban },
};

function CheckList({ checks }: { checks: RevalidationCheck[] }) {
  return (
    <div className="space-y-1">
      {checks.map((c) => (
        <div key={c.name} className="flex items-start gap-2 text-xs font-mono">
          {c.passed
            ? <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
            : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />}
          <span className={cn("shrink-0", c.passed ? "text-muted-foreground" : "text-destructive font-bold")}>{c.name}</span>
          <span className="text-muted-foreground">— {c.detail}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Closed trades that resembled this setup.
 *
 * Three display rules, each mirroring a gate on the server: an unavailable
 * result shows its reason and nothing else; matches are listed as individual
 * facts (this trade, this similarity, this outcome) regardless of how many
 * there are; and the aggregate win rate appears only when the server sends
 * `stats`, which it withholds below its own threshold. Outcome is never
 * carried by colour alone — every row is labelled.
 */
function SimilarTrades({ similar }: { similar: SimilarTradesType }) {
  if (!similar.available) {
    return (
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{similar.reason}</p>
        {similar.poolSize > 0 && (
          <p className="text-xs font-mono text-muted-foreground">
            pool {similar.poolSize}/{similar.minPoolSize} · floor {similar.similarityFloor}
          </p>
        )}
      </div>
    );
  }

  const s = similar.stats;
  return (
    <div className="space-y-3">
      <p className="text-xs font-mono text-muted-foreground">{similar.reason}</p>

      {s ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 font-mono text-sm border-y border-border py-2">
          <div>
            <p className="text-xs text-muted-foreground">Win Rate</p>
            <p className="font-bold">
              {s.winRate != null ? `${(s.winRate * 100).toFixed(0)}%` : "—"}
              {s.winRateLow != null && s.winRateHigh != null && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  ({(s.winRateLow * 100).toFixed(0)}–{(s.winRateHigh * 100).toFixed(0)}%)
                </span>
              )}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Avg R</p>
            <p className="font-bold">{s.avgR != null ? s.avgR.toFixed(2) : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Net P&L</p>
            <p className={cn("font-bold", s.netPnlUsdt > 0 ? "text-success" : s.netPnlUsdt < 0 && "text-destructive")}>
              ${s.netPnlUsdt.toFixed(2)}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Too few matches to summarise as a rate — the individual trades are below.
        </p>
      )}

      {/* Five fixed-width columns used to sit in a row with only a VERTICAL
          overflow wrapper, so under 400px the date column was squeezed to
          nothing. The date now drops out below `sm` — it is the least load-
          bearing column here — and the rest flex instead of holding fixed
          widths. */}
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {similar.matches.map((m) => (
          <div key={m.tradeId} className="flex items-center gap-2 text-xs font-mono sm:gap-3">
            <span className="w-10 shrink-0 tabular-nums text-muted-foreground">{(m.similarity * 100).toFixed(0)}%</span>
            <span className="min-w-0 flex-1 truncate">{m.symbol}</span>
            <span className="hidden shrink-0 text-muted-foreground sm:inline">
              {new Date(m.closedAt).toLocaleDateString()}
            </span>
            <span className={cn(
              "w-14 shrink-0 text-right",
              m.outcome === "win" ? "text-success" : m.outcome === "loss" ? "text-destructive" : "text-muted-foreground",
            )}>
              {m.outcome}
            </span>
            <span className="w-16 shrink-0 text-right tabular-nums">
              {m.rMultiple != null ? `${m.rMultiple.toFixed(2)}R` : `$${m.pnl.toFixed(2)}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof PieChart; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-widest text-muted-foreground mb-3">
          <Icon className="h-3.5 w-3.5" /> {title}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export default function CoPilotWorkspace() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const id = Number(params.id);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [checks, setChecks] = useState<RevalidationCheck[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [qty, setQty] = useState("");

  const { data: config } = useGetConfig({ query: { queryKey: getGetConfigQueryKey() } });
  const { data, isLoading, isError } = useGetRecommendationWorkspace(id, {
    query: { queryKey: getGetRecommendationWorkspaceQueryKey(id), refetchInterval: 15_000, enabled: Number.isInteger(id) },
  });

  const execute = useExecuteRecommendation();
  const reject = useRejectRecommendation();
  const modify = useModifyRecommendation();
  const busy = execute.isPending || reject.isPending || modify.isPending;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetRecommendationWorkspaceQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getGetCopilotInboxQueryKey() });
  };

  if (!Number.isInteger(id)) {
    return <p className="text-sm text-destructive">Invalid recommendation.</p>;
  }
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="space-y-3">
        <button onClick={() => navigate("/copilot")} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to inbox
        </button>
        <Card><CardContent className="py-8 text-center text-sm text-destructive">This recommendation could not be found.</CardContent></Card>
      </div>
    );
  }

  const rec = data.recommendation;
  const isLong = rec.side === "long";
  const meta = STATUS_META[rec.status] ?? STATUS_META["created"]!;
  const StatusIcon = meta.icon;
  const remainingMs = new Date(rec.expiresAt).getTime() - Date.now();
  const expired = remainingMs <= 0;
  const actionable = rec.status === "created" && !expired;

  const onExecute = () => execute.mutate({ id: rec.id }, {
    onSuccess: (result) => {
      setChecks(result.checks ?? null);
      invalidate();
      toast({
        title: result.ok ? "Executed" : "Not executed",
        description: result.reason,
        ...(result.ok ? {} : { variant: "destructive" as const }),
      });
    },
  });

  const onReject = () => reject.mutate({ id: rec.id, data: {} }, {
    onSuccess: (result) => { invalidate(); toast({ title: "Declined", description: result.reason }); },
  });

  const onModify = () => modify.mutate(
    { id: rec.id, data: { slPrice: Number(sl || rec.slPrice), tpPrice: Number(tp || rec.tpPrice), qty: Number(qty || rec.qty) } },
    {
      onSuccess: (result) => {
        invalidate();
        setEditing(false);
        toast({
          title: result.ok ? "Your plan created" : "Could not modify",
          description: result.reason,
          ...(result.ok ? {} : { variant: "destructive" as const }),
        });
        if (result.ok && result.newRecommendationId) navigate(`/copilot/${result.newRecommendationId}`);
      },
    },
  );

  return (
    <div className="space-y-4 pb-8">
      <button onClick={() => navigate("/copilot")} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to inbox
      </button>

      {/* Plan banner */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Badge variant="outline" className={cn("font-mono text-xs", isLong
              ? "bg-success/15 text-success border-success/40"
              : "bg-destructive/10 text-destructive border-destructive/40")}>
              {isLong ? <ArrowUpRight className="h-3 w-3 mr-1" /> : <ArrowDownRight className="h-3 w-3 mr-1" />}
              {rec.side.toUpperCase()}
            </Badge>
            <span className="font-mono font-bold text-lg">{rec.symbol}</span>
            <Badge variant="outline" className={cn("font-mono text-xs", meta.className)}>
              <StatusIcon className="h-3 w-3 mr-1" />{expired && rec.status === "created" ? "Expired" : meta.label}
            </Badge>
            {rec.authoredBy === "user" && (
              <Badge variant="outline" className="font-mono text-xs bg-warning/10 text-warning border-warning/40">
                <Pencil className="h-3 w-3 mr-1" />Your plan
                {rec.derivedFromId != null && <span className="ml-1 opacity-70">from #{rec.derivedFromId}</span>}
              </Badge>
            )}
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {rec.strategyName ?? rec.strategyId} · {rec.confidence.toFixed(0)}% confidence
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-sm">
            <div><p className="text-xs text-muted-foreground">Entry</p><p className="font-bold">{rec.entryPrice}</p></div>
            <div><p className="text-xs text-muted-foreground">Stop</p><p className="font-bold text-destructive">{rec.slPrice}</p></div>
            <div><p className="text-xs text-muted-foreground">Target</p><p className="font-bold text-success">{rec.tpPrice}</p></div>
            <div><p className="text-xs text-muted-foreground">Size</p><p className="font-bold">{rec.qty}{rec.leverage > 1 && ` · ${rec.leverage}x`}</p></div>
          </div>

          {rec.entryReason && <p className="mt-3 text-sm text-muted-foreground">{rec.entryReason}</p>}

          {rec.status === "created" && (
            <p className={cn("mt-3 text-xs font-mono", remainingMs < 120_000 && !expired ? "text-warning font-bold" : "text-muted-foreground")}>
              <Clock className="h-3 w-3 inline mr-1" />
              {expired
                ? "This recommendation has expired — the setup it described is no longer current."
                : `Valid until ${new Date(rec.expiresAt).toISOString().slice(11, 19)} UTC`}
            </p>
          )}
          {rec.resolutionReason && rec.status !== "created" && (
            <p className={cn("mt-3 text-xs font-mono flex items-start gap-1.5", rec.status === "blocked" ? "text-destructive" : "text-muted-foreground")}>
              {rec.status === "blocked" && <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
              {rec.resolutionReason}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Chart */}
      <PositionChart
        symbol={rec.symbol}
        marketType={config?.marketType ?? "spot"}
        side={rec.side as "long" | "short"}
        quantity={rec.qty}
        entryPrice={rec.entryPrice}
        stopLossPrice={rec.slPrice}
        takeProfitPrice={rec.tpPrice}
        tp1Price={null}
        tp1Filled={false}
      />

      {/* Decision timeline */}
      <Section icon={ListTree} title="Decision Timeline">
        <DecisionTimeline stages={data.decisionTrace} />
      </Section>

      {/* Portfolio impact */}
      <Section icon={PieChart} title="Portfolio Impact">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 font-mono text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Open Positions</p>
            <p className="font-bold">{data.portfolioImpact.currentOpenPositions} / {data.portfolioImpact.maxOpenPositions}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">This Plan's Risk</p>
            <p className="font-bold">${data.portfolioImpact.candidateRiskUsdt.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Portfolio Risk Now</p>
            <p className="font-bold">${data.portfolioImpact.currentPortfolioRiskUsdt.toFixed(2)} / ${data.portfolioImpact.maxPortfolioRiskUsdt.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">If This Executes</p>
            <p className={cn("font-bold", data.portfolioImpact.afterPortfolioRiskUsdt > data.portfolioImpact.maxPortfolioRiskUsdt && "text-destructive")}>
              ${data.portfolioImpact.afterPortfolioRiskUsdt.toFixed(2)} / ${data.portfolioImpact.maxPortfolioRiskUsdt.toFixed(2)}
            </p>
          </div>
        </div>
      </Section>

      {/* Similar historical trades — real search, still silent below its gates */}
      <Section icon={Lightbulb} title="Similar Historical Trades">
        <SimilarTrades similar={data.similarTrades} />
      </Section>

      {/* Re-validation results from the last approval attempt, if any */}
      {checks && (
        <Section icon={ShieldAlert} title="Re-Validation">
          <CheckList checks={checks} />
        </Section>
      )}

      {/* Actions */}
      {editing ? (
        <Card>
          <CardContent className="p-4 space-y-3">
            <p className="text-xs font-mono text-muted-foreground">
              This creates a NEW plan authored by you. The engine's original is kept unchanged, so a
              later post-mortem can tell the two apart.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><Label className="text-xs">Stop</Label><Input defaultValue={rec.slPrice} onChange={(e) => setSl(e.target.value)} className="font-mono" /></div>
              <div><Label className="text-xs">Target</Label><Input defaultValue={rec.tpPrice} onChange={(e) => setTp(e.target.value)} className="font-mono" /></div>
              <div><Label className="text-xs">Size</Label><Input defaultValue={rec.qty} onChange={(e) => setQty(e.target.value)} className="font-mono" /></div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={onModify} disabled={busy}>
                {modify.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Create my plan
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      ) : actionable && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={onExecute} disabled={busy}>
            {execute.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Execute
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)} disabled={busy}>
            <Pencil className="h-4 w-4 mr-1" />Modify
          </Button>
          <Button variant="ghost" onClick={onReject} disabled={busy}>
            {reject.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Decline
          </Button>
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRecommendationWorkspace, getGetRecommendationWorkspaceQueryKey,
  useExecuteRecommendation, useRejectRecommendation, useModifyRecommendation,
  useGetConfig, getGetConfigQueryKey, getGetCopilotInboxQueryKey,
  type RevalidationCheck, type SimilarTrades as SimilarTradesType,
} from "@workspace/api-client-react";
import { Card, CardContent, Button, Badge, Input, Label,
} from "@/components/ui";
import { PositionChart } from "@/components/position-chart";
import { DecisionTimeline } from "@/components/decision-timeline";
import { CopilotApprovalDialog } from "@/components/copilot-approval-dialog";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import {
  ArrowLeft, ArrowUpRight, ArrowDownRight, CheckCircle2, XCircle, Ban, Clock,
  Loader2, Pencil, ShieldAlert, Lightbulb, PieChart, ListTree,
  BrainCircuit,
  Activity,
  History,
  Database,
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

const STATUS_META: Record<
  string,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  created:    { label: "Awaiting you", className: "bg-primary/10 text-primary border-primary/40", icon: Clock,
  },
  executed:   { label: "Executed",     className: "bg-success/15 text-success border-success/40", icon: CheckCircle2,
  },
  rejected:   { label: "Declined",     className: "bg-muted text-muted-foreground border-border", icon: XCircle,
  },
  expired:    { label: "Expired",      className: "bg-muted text-muted-foreground border-border", icon: Clock,
  },
  stale: {
    label: "Stale",
    className: "bg-warning/10 text-warning border-warning/40",
    icon: Clock,
  },
  invalidated: {
    label: "Invalidated",
    className: "bg-destructive/10 text-destructive border-destructive/40",
    icon: Ban,
  },
  superseded: { label: "Superseded",   className: "bg-muted text-muted-foreground border-border", icon: Pencil,
  },
  blocked:    { label: "Blocked",      className: "bg-destructive/10 text-destructive border-destructive/40", icon: Ban,
  },
};

function CheckList({ checks }: { checks: RevalidationCheck[] }) {
  return (
    <div className="space-y-1">
      {checks.map((c) => (
        <div key={c.name} className="flex items-start gap-2 text-[13px] font-mono"
        >
          {c.passed
            ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
          )}
          <span
            className={cn(
              "shrink-0",
              c.passed ? "text-muted-foreground" : "text-destructive font-bold",
            )}
          >
            {c.name}
          </span>
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
          <p className="text-[13px] font-mono text-muted-foreground">
            pool {similar.poolSize}/{similar.minPoolSize} · floor{" "}
            {similar.similarityFloor}
          </p>
        )}
      </div>
    );
  }

  const s = similar.stats;
  return (
    <div className="space-y-3">
      <p className="text-[13px] font-mono text-muted-foreground">
        {similar.reason}
      </p>

      {s ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 font-mono text-sm border-y border-border py-2">
          <div>
            <p className="text-[13px] text-muted-foreground">Win Rate</p>
            <p className="font-bold">
              {s.winRate != null ? `${(s.winRate * 100).toFixed(0)}%` : "—"}
              {s.winRateLow != null && s.winRateHigh != null && (
                <span className="ml-1 text-[13px] font-normal text-muted-foreground">
                  ({(s.winRateLow * 100).toFixed(0)}–
                  {(s.winRateHigh * 100).toFixed(0)}%)
                </span>
              )}
            </p>
          </div>
          <div>
            <p className="text-[13px] text-muted-foreground">Avg R</p>
            <p className="font-bold">
              {s.avgR != null ? s.avgR.toFixed(2) : "—"}
            </p>
          </div>
          <div>
            <p className="text-[13px] text-muted-foreground">Net P&L</p>
            <p
              className={cn(
                "font-bold",
                s.netPnlUsdt > 0 ? "text-success" : s.netPnlUsdt < 0 && "text-destructive",
              )}
            >
              ${s.netPnlUsdt.toFixed(2)}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
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
          <div key={m.tradeId} className="flex items-center gap-2 text-[13px] font-mono sm:gap-3"
          >
            <span className="w-10 shrink-0 tabular-nums text-muted-foreground">
              {(m.similarity * 100).toFixed(0)}%
            </span>
            <span className="min-w-0 flex-1 truncate">{m.symbol}</span>
            <span className="hidden shrink-0 text-muted-foreground sm:inline">
              {new Date(m.closedAt).toLocaleDateString()}
            </span>
            <span className={cn(
              "w-14 shrink-0 text-right",
              m.outcome === "win" ? "text-success" : m.outcome === "loss" ? "text-destructive" : "text-muted-foreground",
              )}
            >
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

function Section({ icon: Icon, title,
  children,
}: { icon: typeof PieChart; title: string; children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground mb-3">
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

  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalIdempotencyKey, setApprovalIdempotencyKey] = useState("");
  const [rejectionNote, setRejectionNote] = useState("");

  const { data: config } = useGetConfig({ query: { queryKey: getGetConfigQueryKey() },
  });
  const { data, isLoading, isError } = useGetRecommendationWorkspace(id, {
    query: { queryKey: getGetRecommendationWorkspaceQueryKey(id), refetchInterval: 15_000, enabled: Number.isInteger(id),
    },
  });

  const execute = useExecuteRecommendation();
  const reject = useRejectRecommendation();
  const modify = useModifyRecommendation();
  const busy = execute.isPending || reject.isPending || modify.isPending;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetRecommendationWorkspaceQueryKey(id),
    });
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
        <button onClick={() => navigate("/copilot")} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to inbox
        </button>
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">
            This recommendation could not be found.
          </CardContent>
        </Card>
      </div>
    );
  }

  const rec = data.recommendation;
  const bundle = data.decisionBundle;
  const unifiedDecision = bundle?.unifiedBrain.run.decision;
  const thesis = unifiedDecision?.thesis;
  const isLong = rec.side === "long";
  const meta = STATUS_META[rec.status] ?? STATUS_META["created"]!;
  const StatusIcon = meta.icon;
  const remainingMs = new Date(rec.expiresAt).getTime() - Date.now();
  const expired = remainingMs <= 0;
  const actionable = rec.status === "created" && !expired;

  const approvable =
    actionable &&
    data.approvalState === "APPROVABLE" &&
    data.approvalReadiness.approvable;

  const openApproval = () => {
    setApprovalIdempotencyKey(crypto.randomUUID());
    setApprovalOpen(true);
  };

  const onExecute = ({
    confirmation,
    password,
  }: {
    confirmation: string;
    password?: string;
  }) => {
    if (
      !data.decisionBundleFingerprint ||
      !data.executionTarget ||
      !data.approvalChallenge
    )
      return;
    execute.mutate(
      {
        id: rec.id,
        data: {
          expectedPlanFingerprint: rec.planFingerprint,
          expectedDecisionBundleFingerprint: data.decisionBundleFingerprint,
          executionTarget: data.executionTarget,
          approvalChallenge: data.approvalChallenge,
          idempotencyKey: approvalIdempotencyKey,
          confirmation,
          ...(password && { password }),
        },
      },
      {
    onSuccess: (result) => {
      setChecks(result.checks ?? null);
          setApprovalOpen(false);
          invalidate();
      toast({
        title: result.ok ? "Executed" : "Not executed",
        description: result.reason,
        ...(result.ok ? {} : { variant: "destructive" as const }),
      });
    },
      },
    );
  };

  const onReject = () => {
    if (!data.approvalChallenge) return;
    reject.mutate(
      {
        id: rec.id, data: {
          expectedPlanFingerprint: rec.planFingerprint,
          approvalChallenge: data.approvalChallenge,
          ...(rejectionNote.trim() && { note: rejectionNote.trim() }),
        },
      },
      {
    onSuccess: (result) => { invalidate(); toast({ title: "Declined", description: result.reason }); },
      },
    );
  };

  const onModify = () => modify.mutate(
    { id: rec.id, data: { slPrice: Number(sl || rec.slPrice), tpPrice: Number(tp || rec.tpPrice), qty: Number(qty || rec.qty),
        },
      },
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
      <button onClick={() => navigate("/copilot")} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to inbox
      </button>

      {/* Plan banner */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Badge variant="outline"
              className={cn(
                "font-mono text-[13px]", isLong
              ? "bg-success/15 text-success border-success/40"
              : "bg-destructive/10 text-destructive border-destructive/40",
              )}
            >
              {isLong ? (
                <ArrowUpRight className="h-3 w-3 mr-1" />
              ) : (
                <ArrowDownRight className="h-3 w-3 mr-1" />
              )}
              {rec.side.toUpperCase()}
            </Badge>
            <span className="font-mono font-bold text-lg">{rec.symbol}</span>
            <Badge variant="outline" className={cn("font-mono text-[13px]", meta.className)}
            >
              <StatusIcon className="h-3 w-3 mr-1" />
              {expired && rec.status === "created" ? "Expired" : meta.label}
            </Badge>
            {rec.authoredBy === "user" && (
              <Badge variant="outline" className="font-mono text-[13px] bg-warning/10 text-warning border-warning/40"
              >
                <Pencil className="h-3 w-3 mr-1" />
                Your plan
                {rec.derivedFromId != null && (
                  <span className="ml-1 opacity-70">
                    from #{rec.derivedFromId}
                  </span>
                )}
              </Badge>
            )}
            <span className="ml-auto font-mono text-[13px] text-muted-foreground">
              {rec.strategyName ?? rec.strategyId} · {rec.confidence.toFixed(0)}
              % confidence
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-sm">
            <div>
              <p className="text-[13px] text-muted-foreground">Entry</p>
              <p className="font-bold">{rec.entryPrice}</p>
            </div>
            <div>
              <p className="text-[13px] text-muted-foreground">Stop</p>
              <p className="font-bold text-destructive">{rec.slPrice}</p>
            </div>
            <div>
              <p className="text-[13px] text-muted-foreground">Target</p>
              <p className="font-bold text-success">{rec.tpPrice}</p>
            </div>
            <div>
              <p className="text-[13px] text-muted-foreground">Size</p>
              <p className="font-bold">
                {rec.qty}
                {rec.leverage > 1 && ` · ${rec.leverage}x`}
              </p>
            </div>
          </div>

          {rec.entryReason && (
            <p className="mt-3 text-sm text-muted-foreground">
              {rec.entryReason}
            </p>
          )}

          {rec.status === "created" && (
            <p
              className={cn(
                "mt-3 text-[13px] font-mono", remainingMs < 120_000 && !expired ? "text-warning font-bold" : "text-muted-foreground",
              )}
            >
              <Clock className="h-3 w-3 inline mr-1" />
              Created {new Date(rec.createdAt).toLocaleString()} · {" "}
              {expired
                ? "This recommendation has expired — the setup it described is no longer current."
                : `Valid until ${new Date(rec.expiresAt).toISOString().slice(11, 19)} UTC`}
            </p>
          )}
          {rec.resolutionReason && rec.status !== "created" && (
            <p
              className={cn(
                "mt-3 text-[13px] font-mono flex items-start gap-1.5", rec.status === "blocked" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {rec.status === "blocked" && (
                <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              )}
              {rec.resolutionReason}
            </p>
          )}
        </CardContent>
      </Card>

      <Card
        className={cn(
          "border",
          approvable ? "border-success/40" : "border-destructive/40",
        )}
      >
        <CardContent className="p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={
                approvable
                  ? "border-success/40 bg-success/15 text-success"
                  : "border-destructive/40 bg-destructive/10 text-destructive"
              }
            >
              {data.approvalState}
            </Badge>
            <Badge
              variant="outline"
              className={
                data.executionTarget === "live"
                  ? "border-destructive/40 text-destructive"
                  : "border-primary/40 text-primary"
              }
            >
              {data.executionTarget?.toUpperCase() ?? "UNBOUND"} TARGET
            </Badge>
          </div>
          <p
            className={cn(
              "text-sm",
              approvable
                ? "text-muted-foreground"
                : "font-medium text-destructive",
            )}
          >
            {data.approvalReadiness.reason}
          </p>
          <div className="mt-3">
            <CheckList checks={data.approvalReadiness.checks} />
          </div>
        </CardContent>
      </Card>

      {bundle && thesis && (
        <Section
          icon={BrainCircuit}
          title="Full Thesis and Unified-Brain Context"
        >
          <div className="space-y-4 text-sm">
            <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
              <p className="font-medium">
                Decision authority: {bundle.decisionAuthority}
              </p>
              <p className="mt-1 text-muted-foreground">
                {bundle.unifiedBrain.reason}
              </p>
            </div>
            <div>
              <p className="text-[13px] text-muted-foreground">
                Context and rationale
              </p>
              <p>{thesis.context}</p>
            </div>
            <div>
              <p className="text-[13px] text-muted-foreground">Entry trigger</p>
              <p>{thesis.trigger}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-[13px] text-muted-foreground">
                  Invalidation conditions
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  {thesis.invalidationConditions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-[13px] text-muted-foreground">
                  Target rationale
                </p>
                <p>{thesis.targetRationale}</p>
              </div>
            </div>
            <div>
              <p className="text-[13px] text-muted-foreground">
                Expected path · approximately{" "}
                {Math.round(thesis.expectedDurationSeconds / 60)} minutes
              </p>
              <ol className="list-decimal space-y-1 pl-5">
                {thesis.expectedPath.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ol>
            </div>
          </div>
        </Section>
      )}

      {bundle && unifiedDecision && (
        <Section
          icon={Activity}
          title="Decision, Evidence, Uncertainty, and Regime"
        >
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3 font-mono sm:grid-cols-4">
              <div>
                <p className="text-[13px] text-muted-foreground">
                  Council decision
                </p>
                <p className="font-bold">{unifiedDecision.action}</p>
              </div>
              <div>
                <p className="text-[13px] text-muted-foreground">Reason</p>
                <p className="font-bold">{unifiedDecision.reasonCode}</p>
              </div>
              <div>
                <p className="text-[13px] text-muted-foreground">Uncertainty</p>
                <p className="font-bold">
                  {(unifiedDecision.uncertainty.score * 100).toFixed(0)}%
                </p>
              </div>
              <div>
                <p className="text-[13px] text-muted-foreground">Regime</p>
                <p className="font-bold">
                  {bundle.marketState.inferences.regime}
                </p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[13px] text-muted-foreground">
                  Supporting evidence
                </p>
                {unifiedDecision.supportingEvidence.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {unifiedDecision.supportingEvidence.map((item) => (
                      <li key={item.evidenceId}>
                        {item.summary}{" "}
                        <span className="text-muted-foreground">
                          ({item.source}, {Math.round(item.strength * 100)}%)
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">
                    No supporting evidence references were available.
                  </p>
                )}
              </div>
              <div>
                <p className="mb-1 text-[13px] text-muted-foreground">
                  Opposing evidence
                </p>
                {unifiedDecision.opposingEvidence.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {unifiedDecision.opposingEvidence.map((item) => (
                      <li key={item.evidenceId}>
                        {item.summary}{" "}
                        <span className="text-muted-foreground">
                          ({item.source}, {Math.round(item.strength * 100)}%)
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">
                    No opposing evidence references were available.
                  </p>
                )}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[13px] text-muted-foreground">
                Uncertainty notes
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {unifiedDecision.uncertainty.reasons.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <p className="text-[13px] font-mono text-muted-foreground">
              Market data{" "}
              {new Date(bundle.marketState.dataTimestamp).toLocaleString()} ·
              quality {bundle.marketState.dataQuality.status} · council{" "}
              {bundle.specialistCouncil.consensus.stance}
            </p>
          </div>
        </Section>
      )}

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
            <p className="text-[13px] text-muted-foreground">Open Positions</p>
            <p className="font-bold">
              {data.portfolioImpact.currentOpenPositions} /{" "}
              {data.portfolioImpact.maxOpenPositions}
            </p>
          </div>
          <div>
            <p className="text-[13px] text-muted-foreground">
              This Plan's Risk</p>
            <p className="font-bold">${data.portfolioImpact.candidateRiskUsdt.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-[13px] text-muted-foreground">Portfolio Risk Now</p>
            <p className="font-bold">${data.portfolioImpact.currentPortfolioRiskUsdt.toFixed(2)} / ${data.portfolioImpact.maxPortfolioRiskUsdt.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-[13px] text-muted-foreground">If This Executes</p>
            <p className={cn("font-bold", data.portfolioImpact.afterPortfolioRiskUsdt > data.portfolioImpact.maxPortfolioRiskUsdt && "text-destructive",
              )}>
              ${data.portfolioImpact.afterPortfolioRiskUsdt.toFixed(2)} / ${data.portfolioImpact.maxPortfolioRiskUsdt.toFixed(2)}
            </p>
          </div>
        </div>
      </Section>

      {bundle && (
        <Section icon={Database} title="Immutable Decision and Policy Versions">
          <div className="grid gap-2 font-mono text-[13px] sm:grid-cols-2">
            {Object.entries(bundle.versions).map(([name, value]) => (
              <div key={name} className="min-w-0">
                <span className="text-muted-foreground">{name}: </span>
                <span className="break-all">{value ?? "not applicable"}</span>
              </div>
            ))}
            <div className="min-w-0 sm:col-span-2">
              <span className="text-muted-foreground">plan fingerprint: </span>
              <span className="break-all">{rec.planFingerprint}</span>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <span className="text-muted-foreground">
                bundle fingerprint:{" "}
              </span>
              <span className="break-all">
                {data.decisionBundleFingerprint}
              </span>
            </div>
          </div>
          {bundle.limitations.length > 0 && (
            <div className="mt-3 rounded-md border border-warning/30 bg-warning/5 p-3 text-[13px]">
              <p className="mb-1 font-medium">Known limitations</p>
              <ul className="list-disc space-y-1 pl-5">
                {bundle.limitations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      <Section icon={History} title="Approval Audit Trail">
        {data.auditEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No lifecycle events are available for this legacy proposal.
          </p>
        ) : (
          <div className="space-y-2">
            {data.auditEvents.map((event) => (
              <div
                key={event.id}
                className="rounded-md border border-border p-3 text-[13px]"
              >
                <div className="flex flex-wrap items-center gap-2 font-mono">
                  <Badge variant="outline">{event.eventType}</Badge>
                  <span>{event.reasonCode}</span>
                  <span className="ml-auto text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 text-muted-foreground">{event.reason}</p>
                <p className="mt-1 font-mono text-muted-foreground">
                  actor {event.actorType}
                  {event.actorUserId != null
                    ? ` #${event.actorUserId}`
                    : ""} · {event.fromStatus ?? "none"} → {event.toStatus}
                </p>
              </div>
            ))}
          </div>
        )}
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
            <p className="text-[13px] font-mono text-muted-foreground">
              Only a smaller size or tighter protective stop may reuse this
              decision. A wider stop, larger size, or different target requires
              a new engine proposal.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><Label className="text-[13px]">Stop</Label><Input defaultValue={rec.slPrice} onChange={(e) => setSl(e.target.value)} className="font-mono" /></div>
              <div><Label className="text-[13px]">Target (frozen)</Label><Input defaultValue={rec.tpPrice}
                  disabled
                  onChange={(e) => setTp(e.target.value)} className="font-mono" /></div>
              <div><Label className="text-[13px]">Size</Label><Input defaultValue={rec.qty} onChange={(e) => setQty(e.target.value)} className="font-mono" /></div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={onModify} disabled={busy}>
                {modify.isPending && (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                )}Create my plan
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        actionable && (
        <div className="space-y-3 rounded-md border border-border p-4">
            <div className="flex flex-wrap gap-2">
          <Button onClick={openApproval} disabled={busy || !approvable}>
            {execute.isPending && (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                )}
                Approve one controlled attempt
              </Button>
          <Button variant="outline" onClick={() => setEditing(true)} disabled={busy}>
            <Pencil className="h-4 w-4 mr-1" />
                Reduce risk
              </Button>
          <Button variant="ghost" onClick={() => navigate("/copilot")}
                disabled={busy}
              >
                Wait and return
              </Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={rejectionNote}
                onChange={(event) => setRejectionNote(event.target.value)}
                maxLength={1000}
                placeholder="Optional rejection rationale (observational feedback)"
                aria-label="Optional rejection rationale"
              />
              <Button
                variant="ghost"
                onClick={onReject} disabled={busy || !data.approvalChallenge}>
            {reject.isPending && (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                )}
                Reject proposal
              </Button>
        </div>
          </div>
        )
      )}

      {bundle && data.executionTarget && (
        <CopilotApprovalDialog
          open={approvalOpen}
          onOpenChange={setApprovalOpen}
          symbol={rec.symbol}
          side={rec.side}
          target={data.executionTarget}
          quantity={rec.qty}
          entryPrice={rec.entryPrice}
          stopPrice={rec.slPrice}
          targetPrice={rec.tpPrice}
          leverage={rec.leverage}
          maximumLoss={bundle.risk.candidateMaximumLoss}
          approvable={approvable}
          readinessReason={data.approvalReadiness.reason}
          pending={execute.isPending}
          onConfirm={onExecute}
        />
      )}
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Eye,
  RefreshCw,
  Scale,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/patterns";
import { sectionHeaders, useSection } from "@/lib/section";
import { cn } from "@/lib/utils";

interface EvidenceReference {
  evidenceId: string;
  source: string;
  summary: string;
  strength: number;
}

interface SpecialistView {
  role: string;
  correlationGroup: string;
  correlationDiscount: number;
  effectiveStrength: number;
  operationalStatus: "active" | "abstained";
  opinion: {
    specialistId: string;
    stance: "long" | "short" | "neutral" | "abstain";
    uncertainty: number;
    abstentionReason: string | null;
    supportingEvidence: EvidenceReference[];
    opposingEvidence: EvidenceReference[];
  };
}

interface ShadowRun {
  runId: string;
  runFingerprint: string;
  mode: "shadow";
  cannotExecute: true;
  generatedAt: string;
  decision: {
    decisionId: string;
    action: "ENTER_NOW" | "WAIT_FOR_TRIGGER" | "OBSERVE" | "REJECT" | "REDUCE" | "EXIT";
    symbol: string;
    reasonCode: string;
    dataTimestamp: string;
    expiresAt: string;
    supportingEvidence: EvidenceReference[];
    opposingEvidence: EvidenceReference[];
    uncertainty: { score: number; reasons: string[]; calibrated: boolean };
    thesis: null | {
      side: "long" | "short";
      context: string;
      trigger: string;
      invalidationConditions: string[];
      targetRationale: string;
    };
    proposedTrade: null | {
      strategyName: string;
      side: "long" | "short";
      entryPrice: number;
      stopPrice: number;
      targetPrice: number;
      netRewardRisk: number | null;
    };
  };
  deterministicAssessment: {
    longScore: number;
    shortScore: number;
    decisionStrength: number;
    regimeSuitability: number;
    costPenalty: number;
    ruleTrace: string[];
  };
  reasoning: {
    status: string;
    providerId: string | null;
    modelVersion: string | null;
    summary: string;
    validationFailures: string[];
    latencyMs: number;
    usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  };
  replay: {
    marketState: {
      fingerprint: string;
      venue: string;
      dataTimestamp: string;
      freshness: { status: string; ageMs: number };
      dataQuality: { status: string; issues: string[] };
      inferences: { regime: string; regimeConfidence: number; dominantDirection: string };
    };
    specialistCouncil: {
      consensus: { stance: string; explanation: string; disagreement: boolean; abstentions: number };
      opinions: SpecialistView[];
    };
    executionCosts: { feeRatePerLeg: number; slippageRatePerLeg: number; version: string };
    portfolio: { status: string; availableBalance: number | null; openPositionCount: number | null; limitations: string[] };
    historicalEvidence: { status: string; limitations: string[] };
    brainV0: {
      disposition: "CANDIDATE_PRODUCED" | "NO_CANDIDATE";
      candidateCount: number;
      topCandidate: null | { strategyName: string; side: string; confidence: number; netRewardRisk: number | null };
    };
  };
}

const ACTION_STYLE: Record<ShadowRun["decision"]["action"], string> = {
  ENTER_NOW: "border-success/40 bg-success/10 text-success",
  WAIT_FOR_TRIGGER: "border-primary/40 bg-primary/10 text-primary",
  OBSERVE: "border-border bg-muted/40 text-muted-foreground",
  REJECT: "border-destructive/40 bg-destructive/10 text-destructive",
  REDUCE: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400",
  EXIT: "border-destructive/40 bg-destructive/10 text-destructive",
};

function readable(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function EvidenceList({ title, items, tone }: { title: string; items: EvidenceReference[]; tone: "support" | "oppose" }) {
  const Icon = tone === "support" ? CheckCircle2 : XCircle;
  return (
    <div>
      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className={cn("h-3.5 w-3.5", tone === "support" ? "text-success" : "text-destructive")} />
        {title}
      </h4>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No evidence references in this category.</p>
      ) : (
        <ul className="space-y-2">
          {items.slice(0, 6).map((item) => (
            <li key={item.evidenceId} className="rounded-md border bg-muted/20 p-2.5 text-sm">
              <p>{item.summary}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {readable(item.source)} · evidence weight {percent(item.strength)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 font-mono text-lg font-semibold", warning && "text-yellow-400")}>{value}</p>
    </div>
  );
}

function Replay({ run }: { run: ShadowRun }) {
  const { replay } = run;
  return (
    <details className="group rounded-lg border bg-muted/10">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        Reconstruct this decision
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-5 border-t p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Regime" value={readable(replay.marketState.inferences.regime)} />
          <Metric label="Regime support" value={percent(replay.marketState.inferences.regimeConfidence)} />
          <Metric label="Data quality" value={readable(replay.marketState.dataQuality.status)} warning={replay.marketState.dataQuality.status !== "healthy"} />
          <Metric label="Council stance" value={readable(replay.specialistCouncil.consensus.stance)} warning={replay.specialistCouncil.consensus.disagreement} />
        </div>

        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">What each specialist knew</h4>
          <div className="space-y-2">
            {replay.specialistCouncil.opinions.map((view) => (
              <div key={view.opinion.specialistId} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_auto]">
                <div>
                  <p className="text-sm font-medium">{readable(view.opinion.specialistId)}</p>
                  <p className="text-xs text-muted-foreground">
                    {readable(view.role)} · {view.opinion.abstentionReason ?? `${readable(view.opinion.stance)} stance`}
                  </p>
                </div>
                <div className="text-left text-xs text-muted-foreground sm:text-right">
                  <p>Effective weight {percent(view.effectiveStrength)}</p>
                  <p>Correlation multiplier {view.correlationDiscount.toFixed(2)}×</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Known costs</p>
            <p className="mt-1 text-muted-foreground">
              Fee {percent(replay.executionCosts.feeRatePerLeg)} per leg · slippage {percent(replay.executionCosts.slippageRatePerLeg)} per leg
            </p>
          </div>
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Known limitations</p>
            {[...replay.portfolio.limitations, ...replay.historicalEvidence.limitations].map((limitation) => (
              <p key={limitation} className="mt-1 text-muted-foreground">• {limitation}</p>
            ))}
          </div>
        </div>
        <p className="break-all font-mono text-[10px] text-muted-foreground">MarketState {replay.marketState.fingerprint}</p>
      </div>
    </details>
  );
}

function DecisionCard({ run }: { run: ShadowRun }) {
  const stale = Date.now() >= Date.parse(run.decision.expiresAt);
  const v0 = run.replay.brainV0;
  return (
    <Card className={cn(stale && "border-yellow-500/40")}>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
              {run.decision.symbol}
              <Badge variant="outline" className={ACTION_STYLE[run.decision.action]}>{readable(run.decision.action)}</Badge>
              {stale && <Badge variant="warning">Expired</Badge>}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {readable(run.decision.reasonCode)} · snapshot {new Date(run.decision.dataTimestamp).toLocaleString()}
            </p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <p>Uncertainty {percent(run.decision.uncertainty.score)}</p>
            <p>Uncalibrated support score</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Decision support" value={percent(run.deterministicAssessment.decisionStrength)} />
          <Metric label="Long / Short" value={`${run.deterministicAssessment.longScore.toFixed(2)} / ${run.deterministicAssessment.shortScore.toFixed(2)}`} />
          <Metric label="Regime suitability" value={percent(run.deterministicAssessment.regimeSuitability)} />
          <Metric label="Cost penalty" value={percent(run.deterministicAssessment.costPenalty)} warning={run.deterministicAssessment.costPenalty >= 0.5} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border p-4">
            <div className="mb-2 flex items-center gap-2">
              <Scale className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">Brain V0 control</h3>
            </div>
            {v0.topCandidate ? (
              <p className="text-sm text-muted-foreground">
                {readable(v0.topCandidate.strategyName)} produced a {v0.topCandidate.side} candidate at score {v0.topCandidate.confidence.toFixed(0)}.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Brain V0 produced no candidate on this same snapshot.</p>
            )}
          </div>
          <div className="rounded-lg border p-4">
            <div className="mb-2 flex items-center gap-2">
              <BrainCircuit className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">Shadow candidate</h3>
            </div>
            <p className="text-sm text-muted-foreground">{run.reasoning.summary}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Reasoning review: {readable(run.reasoning.status)}
              {run.reasoning.modelVersion ? ` · ${run.reasoning.modelVersion}` : " · deterministic only"}
            </p>
          </div>
        </div>

        {run.decision.thesis && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
            <h3 className="font-semibold">Current Shadow thesis</h3>
            <p className="mt-2 text-sm">{run.decision.thesis.context}</p>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
              <div><dt className="text-xs text-muted-foreground">Trigger</dt><dd className="mt-1">{run.decision.thesis.trigger}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Invalidation</dt><dd className="mt-1">{run.decision.thesis.invalidationConditions.join(" · ")}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Target rationale</dt><dd className="mt-1">{run.decision.thesis.targetRationale}</dd></div>
            </dl>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <EvidenceList title="Evidence for" items={run.decision.supportingEvidence} tone="support" />
          <EvidenceList title="Evidence against" items={run.decision.opposingEvidence} tone="oppose" />
        </div>

        <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
          {run.deterministicAssessment.ruleTrace.map((rule) => <p key={rule}>• {rule}</p>)}
          {run.decision.uncertainty.reasons.map((reason) => <p key={reason}>• {reason}</p>)}
        </div>

        <Replay run={run} />
      </CardContent>
    </Card>
  );
}

export function AiBrain() {
  const { section } = useSection();
  const query = useQuery<ShadowRun[]>({
    queryKey: ["shadow-decision-council", section],
    queryFn: async () => {
      const response = await fetch("/api/intelligence/shadow", {
        credentials: "same-origin",
        headers: sectionHeaders(),
      });
      if (!response.ok) throw new Error(`Shadow Council request failed (${response.status})`);
      return response.json() as Promise<ShadowRun[]>;
    },
    refetchInterval: 10_000,
  });

  const runs = query.data ?? [];
  const candidateCount = runs.filter((run) => run.decision.action === "ENTER_NOW" || run.decision.action === "WAIT_FOR_TRIGGER").length;
  const abstentionCount = runs.filter((run) => run.decision.action === "OBSERVE" || run.decision.action === "REJECT").length;
  const validationFailures = runs.reduce((sum, run) => sum + run.reasoning.validationFailures.length, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        icon={BrainCircuit}
        title="AI Brain"
        description="The unified council evaluates the same closed-candle snapshots as Brain V0 and records what it would do."
        actions={
          <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={cn("mr-2 h-3.5 w-3.5", query.isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />

      <div role="status" className="flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/10 p-4 text-primary">
        <Eye className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="font-semibold">Shadow — cannot execute</p>
          <p className="mt-1 text-sm text-muted-foreground">
            These are research decisions only. They cannot place orders, change risk, or alter Brain V0, Demo, Co-Pilot, or Live behavior.
          </p>
        </div>
      </div>

      {!query.isLoading && !query.isError && runs.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Current snapshots" value={String(runs.length)} />
          <Metric label="Candidates / waiting" value={String(candidateCount)} />
          <Metric label="Observed / rejected" value={String(abstentionCount)} />
          <Metric label="Discarded AI claims" value={String(validationFailures)} warning={validationFailures > 0} />
        </div>
      )}

      {query.isLoading ? (
        <div className="grid gap-4" aria-label="Loading Shadow decisions">
          {[0, 1].map((item) => <div key={item} className="h-64 animate-pulse rounded-lg border bg-muted/30" />)}
        </div>
      ) : query.isError ? (
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-3 p-5">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
            <div>
              <p className="font-medium">Shadow Council is unavailable</p>
              <p className="mt-1 text-sm text-muted-foreground">{query.error instanceof Error ? query.error.message : "The request failed."}</p>
            </div>
          </CardContent>
        </Card>
      ) : runs.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Clock3}
              title="Waiting for the first closed-candle replay"
              description="Start the engine and allow one full scan. No synthetic Shadow decisions are shown while market data is unavailable or degraded."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {runs.map((run) => <DecisionCard key={run.runId} run={run} />)}
        </div>
      )}

      <Card>
        <CardContent className="flex items-start gap-3 p-4 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <p>
            AI reasoning, when configured, can only annotate evidence. The deterministic council owns the Shadow result; deterministic risk remains the authority before any future financial action.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}


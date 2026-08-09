import { useQuery } from "@tanstack/react-query";
import { getSpecialistCouncil } from "@workspace/api-client-react";
import { AlertTriangle, BrainCircuit, ChevronRight, MinusCircle, Scale, ShieldCheck } from "lucide-react";
import { Badge, Card, CardContent } from "@/components/ui";
import { useSection } from "@/lib/section";
import { cn } from "@/lib/utils";

type Stance = "long" | "short" | "neutral" | "abstain";

interface Opinion {
  role: string;
  correlationGroup: string;
  correlationDiscount: number;
  effectiveStrength: number;
  operationalStatus: "active" | "abstained";
  opinion: {
    opinionId: string;
    specialistId: string;
    stance: Stance;
    strength: number;
    applicableRegimes: string[];
    supportingEvidence: Array<{ evidenceId: string; summary: string; strength: number }>;
    opposingEvidence: Array<{ evidenceId: string; summary: string; strength: number }>;
    uncertainty: number;
    abstentionReason: string | null;
    dataTimestamp: string;
    expiresAt: string;
  };
}

interface CouncilSnapshot {
  councilVersion: string;
  mode: "observational";
  cannotExecute: true;
  symbol: string;
  marketStateFingerprint: string;
  dataTimestamp: string;
  generatedAt: string;
  consensus: {
    stance: "long" | "short" | "mixed" | "abstain";
    longScore: number;
    shortScore: number;
    actionableOpinions: number;
    abstentions: number;
    disagreement: boolean;
    explanation: string;
  };
  opinions: Opinion[];
}

const stanceClass: Record<string, string> = {
  long: "border-success/40 bg-success/10 text-success",
  short: "border-destructive/40 bg-destructive/10 text-destructive",
  mixed: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400",
  neutral: "border-muted bg-muted/50 text-muted-foreground",
  abstain: "border-muted bg-muted/50 text-muted-foreground",
};

function evidenceLabel(opinion: Opinion): string {
  const forCount = opinion.opinion.supportingEvidence.length;
  const againstCount = opinion.opinion.opposingEvidence.length;
  return `${forCount} for · ${againstCount} against`;
}

export function SpecialistCouncil() {
  const { section } = useSection();
  const query = useQuery<CouncilSnapshot[]>({
    queryKey: ["specialist-council", section],
    refetchInterval: 15_000,
    queryFn: async () => (await getSpecialistCouncil()) as CouncilSnapshot[],
  });

  const snapshots = [...(query.data ?? [])]
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    .slice(0, 8);
  const disagreementCount = snapshots.filter((item) => item.consensus.disagreement).length;
  const activeOpinions = snapshots.reduce((sum, item) => sum + item.consensus.actionableOpinions, 0);
  const abstentions = snapshots.reduce((sum, item) => sum + item.consensus.abstentions, 0);

  return (
    <section className="space-y-3" aria-labelledby="specialist-council-title">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="specialist-council-title" className="flex items-center gap-2 text-base font-semibold">
            <BrainCircuit className="h-4 w-4 text-primary" />
            Specialist Council
          </h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Brain V0 decisions translated into independent specialist opinions. Observational only—risk and execution do not read this council.
          </p>
        </div>
        <Badge variant="outline" className="font-mono text-[10px]">
          Phase 3 · cannot execute
        </Badge>
      </div>

      {query.isError && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          Specialist opinions are unavailable. Existing trading behavior is unaffected.
        </div>
      )}

      {query.isLoading ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Loading specialist opinions…</CardContent></Card>
      ) : snapshots.length === 0 && !query.isError ? (
        <Card>
          <CardContent className="py-8 text-center">
            <MinusCircle className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-medium">No current specialist snapshot</p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Start the engine or wait for the next complete closed-candle scan. No prior opinion is shown as current.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-lg border bg-card p-3">
              <p className="text-[11px] text-muted-foreground">Active opinions</p>
              <p className="font-mono text-xl font-semibold">{activeOpinions}</p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-[11px] text-muted-foreground">Abstentions</p>
              <p className="font-mono text-xl font-semibold">{abstentions}</p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-[11px] text-muted-foreground">Disagreements</p>
              <p className={cn("font-mono text-xl font-semibold", disagreementCount > 0 && "text-yellow-400")}>{disagreementCount}</p>
            </div>
          </div>

          <div className="space-y-3">
            {snapshots.map((snapshot) => (
              <Card key={snapshot.symbol}>
                <CardContent className="space-y-3 pt-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{snapshot.symbol}</span>
                        <Badge variant="outline" className={cn("text-[10px]", stanceClass[snapshot.consensus.stance])}>
                          {snapshot.consensus.stance}
                        </Badge>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">{snapshot.consensus.explanation}</p>
                    </div>
                    <div className="text-right text-[10px] text-muted-foreground">
                      <p>{new Date(snapshot.dataTimestamp).toLocaleString()}</p>
                      <p className="font-mono">state {snapshot.marketStateFingerprint.slice(0, 10)}</p>
                    </div>
                  </div>

                  {snapshot.consensus.disagreement && (
                    <div className="flex items-center gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-[12px] text-yellow-300">
                      <Scale className="h-4 w-4 shrink-0" />
                      Long and short specialists materially disagree after correlated-opinion discounting.
                    </div>
                  )}

                  <div className="grid gap-2 md:grid-cols-2">
                    {snapshot.opinions.map((view) => (
                      <details key={view.opinion.opinionId} className="group rounded-md border bg-muted/20">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-[12px] font-medium">{view.opinion.specialistId.replaceAll("_", " ")}</span>
                              <Badge variant="outline" className={cn("text-[9px]", stanceClass[view.opinion.stance])}>
                                {view.opinion.stance}
                              </Badge>
                              {view.correlationDiscount < 1 && (
                                <Badge variant="outline" className="text-[9px] text-yellow-400">
                                  correlated ×{view.correlationDiscount}
                                </Badge>
                              )}
                            </div>
                            <p className="mt-1 text-[10px] text-muted-foreground">
                              {view.role.replaceAll("_", " ")} · {evidenceLabel(view)} · uncertainty {(view.opinion.uncertainty * 100).toFixed(0)}%
                            </p>
                          </div>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                        </summary>

                        <div className="space-y-2 border-t px-3 py-3 text-[11px]">
                          <p><span className="text-muted-foreground">Mandate:</span> evaluate {view.role.replaceAll("_", " ")} evidence in {view.opinion.applicableRegimes.map((r) => r.replaceAll("_", " ")).join(", ")} regimes.</p>
                          <p><span className="text-muted-foreground">Evidence quality:</span> effective strength {(view.effectiveStrength * 100).toFixed(0)}% after independence discount.</p>
                          <p><span className="text-muted-foreground">Calibration:</span> not yet statistically calibrated; Phase 5 evidence is required.</p>
                          {view.opinion.abstentionReason && (
                            <p><span className="text-muted-foreground">Why it abstained:</span> {view.opinion.abstentionReason}</p>
                          )}
                          {view.opinion.supportingEvidence.length > 0 && (
                            <div>
                              <p className="font-medium text-success">Supporting evidence</p>
                              <ul className="mt-1 space-y-1 text-muted-foreground">
                                {view.opinion.supportingEvidence.slice(0, 3).map((item) => <li key={item.evidenceId}>• {item.summary}</li>)}
                              </ul>
                            </div>
                          )}
                          {view.opinion.opposingEvidence.length > 0 && (
                            <div>
                              <p className="font-medium text-destructive">Opposing evidence</p>
                              <ul className="mt-1 space-y-1 text-muted-foreground">
                                {view.opinion.opposingEvidence.slice(0, 3).map((item) => <li key={item.evidenceId}>• {item.summary}</li>)}
                              </ul>
                            </div>
                          )}
                          <div className="flex items-center gap-1.5 border-t pt-2 text-muted-foreground">
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Operational status: {view.operationalStatus}. No broker or risk-policy authority.
                          </div>
                        </div>
                      </details>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

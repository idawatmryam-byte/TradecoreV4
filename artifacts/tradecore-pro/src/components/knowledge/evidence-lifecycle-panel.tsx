import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getEvidenceOverview,
  promoteEvidenceVersion,
  rollbackEvidenceVersion,
  suspendEvidenceVersion,
  validateEvidence,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  BrainCog,
  CheckCircle2,
  FlaskConical,
  History,
  Loader2,
  PauseCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { useToast } from "@/components/ui/use-toast";
import { useSection } from "@/lib/section";
import { cn } from "@/lib/utils";

const PROMOTION_CONFIRMATION = "APPROVE_WITHHOLD_ONLY";
const ROLLBACK_CONFIRMATION = "ROLLBACK_TO_VALIDATED_VERSION";

type Lifecycle = "observational" | "shadow" | "approved" | "active" | "suspended" | "retired";
type Drift = "stable" | "watch" | "degraded" | "insufficient_data";

interface EvidenceRecord {
  evidenceId: string;
  lifecycle: "observational" | "shadow";
  learnedStatement: string;
  permittedBehavior: string;
  permission: "observe" | "withhold" | "reduce-risk";
  ageDays: number;
  halfLifeDays: number;
  decayWeight: number;
  scope: { dimension: string; key: string; label: string };
  metrics: {
    samples: number;
    minimumSamples: number;
    gated: boolean;
    winRate: number | null;
    winRateInterval: { lower: number; upper: number } | null;
    grossPnlUsdt: number | null;
    feesUsdt: number | null;
    slippageUsdt: number | null;
    netPnlUsdt: number;
    averageR: number | null;
    averageMaeUsdt: number | null;
    averageMfeUsdt: number | null;
    excursionCoverage: number;
  };
  statistics: {
    qValue: number | null;
    falseDiscoveryRate: number;
    significant: boolean;
    effectDirection: string;
  };
  drift: { status: Drift; reason: string };
}

interface ValidationView {
  verdict?: string;
  summary?: string;
  validationTrades?: number;
  embargoedTrades?: number;
  expectancyDelta?: number;
}

interface RuleSetView {
  ruleVersion: string;
  status: Lifecycle;
  validationId: number;
  executionTarget: "demo" | "live";
  permits: "withhold" | "reduce-risk";
  dataCutoff: string;
  approvedAt: string | null;
  activatedAt: string | null;
  suspendedAt: string | null;
  createdAt: string;
  validation: ValidationView;
  drift: { status: Drift };
}

interface EvidenceOverview {
  executionTarget: "demo" | "live";
  activeRuleVersion: string | null;
  snapshot: {
    snapshotVersion: string;
    generatedAt: string;
    dataCutoff: string;
    totalOutcomes: number;
    minimumSamples: number;
    falseDiscoveryRate: number;
    cellsTested: number;
    records: EvidenceRecord[];
    limitations: string[];
  };
  ruleSets: RuleSetView[];
}

const money = (value: number | null) => value == null
  ? "not captured"
  : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
const percent = (value: number | null) => value == null ? "—" : `${Math.round(value * 100)}%`;
const readable = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const STATUS_STYLE: Record<Lifecycle, string> = {
  observational: "border-border text-muted-foreground",
  shadow: "border-primary/40 text-primary",
  approved: "border-primary/40 text-primary",
  active: "border-success/40 text-success",
  suspended: "border-warning/40 text-warning",
  retired: "border-border text-muted-foreground",
};

const DRIFT_STYLE: Record<Drift, string> = {
  stable: "text-success",
  watch: "text-warning",
  degraded: "text-destructive",
  insufficient_data: "text-muted-foreground",
};

export function EvidenceLifecyclePanel() {
  const { section } = useSection();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [action, setAction] = useState<{ kind: "promote" | "rollback"; version: string } | null>(null);
  const [confirmation, setConfirmation] = useState("");

  const queryKey = ["learning-evidence", section] as const;
  const query = useQuery<EvidenceOverview>({
    queryKey,
    queryFn: async () => (await getEvidenceOverview()) as EvidenceOverview,
  });
  const validate = useMutation({
    mutationFn: async () => (await validateEvidence()) as ValidationView,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey });
      toast({ title: `Validation: ${readable(result.verdict ?? "completed")}`, description: result.summary });
    },
    onError: (error: Error) => toast({ title: "Validation failed", description: error.message, variant: "destructive" }),
  });
  const transition = useMutation({
    mutationFn: async (input: {
      kind: "promote" | "rollback" | "suspend";
      version: string;
      confirmation?: string;
      reason?: string;
    }) => {
      if (input.kind === "promote") {
        return promoteEvidenceVersion(input.version, { confirmation: input.confirmation ?? "" });
      }
      if (input.kind === "rollback") {
        return rollbackEvidenceVersion(input.version, { confirmation: input.confirmation ?? "" });
      }
      return suspendEvidenceVersion(input.version, { reason: input.reason ?? "Suspended from Learning & Evidence." });
    },
    onSuccess: async (result) => {
      setAction(null);
      setConfirmation("");
      await queryClient.invalidateQueries({ queryKey });
      toast({ title: "Evidence lifecycle updated", description: result.reason });
    },
    onError: (error: Error) => toast({ title: "Action refused", description: error.message, variant: "destructive" }),
  });

  const records = useMemo(() => query.data?.snapshot.records ?? [], [query.data]);
  const actionable = records.filter((record) => record.lifecycle === "shadow").length;
  const expectedPhrase = action?.kind === "promote" ? PROMOTION_CONFIRMATION : ROLLBACK_CONFIRMATION;

  if (query.isLoading) {
    return <Card><CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Building point-in-time evidence…</CardContent></Card>;
  }
  if (query.isError || !query.data) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="flex items-start gap-3 p-6">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div><p className="font-medium">Evidence unavailable</p><p className="text-sm text-muted-foreground">{query.error?.message ?? "The evidence read model could not be loaded."}</p></div>
          <Button className="ml-auto" size="sm" variant="outline" onClick={() => query.refetch()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const data = query.data;
  return (
    <div className="space-y-6">
      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <BrainCog className="h-4 w-4 text-primary" /> Evidence control plane
            <Badge variant="outline" className="ml-auto">{data.executionTarget}</Badge>
          </CardTitle>
          <p className="text-[13px] text-muted-foreground">
            Evidence is observational by default. A statistically improved rule set remains Shadow until you approve its exact version; active authority is limited to withholding a matching candidate.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Closed outcomes" value={String(data.snapshot.totalOutcomes)} />
            <Metric label="Cells tested" value={String(data.snapshot.cellsTested)} />
            <Metric label="Shadow findings" value={String(actionable)} />
            <Metric label="Active version" value={data.activeRuleVersion ? "1 exact version" : "none"} />
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
            <FlaskConical className="h-4 w-4 text-primary" />
            <span className="flex-1 text-muted-foreground">Chronological train/validation split · 24-hour embargo · minimum 40 out-of-sample trades · Benjamini–Hochberg correction</span>
            <Button size="sm" variant="outline" disabled={validate.isPending} onClick={() => validate.mutate()}>
              {validate.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}Validate current record
            </Button>
          </div>
          <p className="break-all font-mono text-[10px] text-muted-foreground">
            Snapshot {data.snapshot.snapshotVersion} · data cutoff {new Date(data.snapshot.dataCutoff).toLocaleString()}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[15px]"><History className="h-4 w-4 text-primary" /> What the brain learned</CardTitle>
          <p className="text-[13px] text-muted-foreground">Every estimate shows its sample size, uncertainty, correction state, age, and permitted behavior.</p>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Scope and claim</TableHead><TableHead>Evidence</TableHead><TableHead>Outcome economics</TableHead><TableHead>Drift / decay</TableHead><TableHead>Authority</TableHead></TableRow></TableHeader>
            <TableBody>
              {records.map((record) => (
                <TableRow key={record.evidenceId}>
                  <TableCell className="min-w-72 align-top">
                    <p className="font-medium">{record.scope.label}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{record.learnedStatement}</p>
                  </TableCell>
                  <TableCell className="min-w-44 align-top font-mono text-xs">
                    <p>{record.metrics.samples} outcomes {record.metrics.gated && `(needs ${record.metrics.minimumSamples})`}</p>
                    <p className="text-muted-foreground">Win {percent(record.metrics.winRate)}{record.metrics.winRateInterval && ` (${percent(record.metrics.winRateInterval.lower)}–${percent(record.metrics.winRateInterval.upper)})`}</p>
                    <p className="text-muted-foreground">q {record.statistics.qValue?.toFixed(3) ?? "—"} · FDR {record.statistics.falseDiscoveryRate}</p>
                  </TableCell>
                  <TableCell className="min-w-44 align-top font-mono text-xs">
                    <p>Net {money(record.metrics.netPnlUsdt)}</p>
                    <p className="text-muted-foreground">Gross {money(record.metrics.grossPnlUsdt)} · R {record.metrics.averageR?.toFixed(2) ?? "—"}</p>
                    <p className="text-muted-foreground">MAE / MFE {money(record.metrics.averageMaeUsdt)} / {money(record.metrics.averageMfeUsdt)}</p>
                  </TableCell>
                  <TableCell className="min-w-36 align-top text-xs">
                    <p className={DRIFT_STYLE[record.drift.status]}>{readable(record.drift.status)}</p>
                    <p className="text-muted-foreground">age {record.ageDays.toFixed(0)}d · weight {percent(record.decayWeight)}</p>
                  </TableCell>
                  <TableCell className="min-w-44 align-top">
                    <Badge variant="outline" className={STATUS_STYLE[record.lifecycle]}>{record.lifecycle}</Badge>
                    <p className="mt-2 text-xs text-muted-foreground">{record.permittedBehavior}</p>
                  </TableCell>
                </TableRow>
              ))}
              {records.length === 0 && <TableRow><TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">No closed outcomes yet. Evidence remains empty and cannot influence decisions.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[15px]"><ShieldCheck className="h-4 w-4 text-primary" /> Validated versions</CardTitle>
          <p className="text-[13px] text-muted-foreground">Validation and activation are separate events. Only one exact version can be active for this section and execution target.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.ruleSets.map((ruleSet) => (
            <div key={ruleSet.ruleVersion} className={cn("rounded-lg border p-4", ruleSet.status === "active" && "border-success/40 bg-success/5")}>
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={STATUS_STYLE[ruleSet.status]}>{ruleSet.status}</Badge>
                    <Badge variant="outline">{ruleSet.executionTarget}</Badge>
                    <span className={cn("text-xs", DRIFT_STYLE[ruleSet.drift.status])}>{readable(ruleSet.drift.status)} drift</span>
                  </div>
                  <p className="mt-2 break-all font-mono text-xs">{ruleSet.ruleVersion}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{ruleSet.validation.summary ?? "Validation details unavailable."}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Permission: {ruleSet.permits} only · cutoff {new Date(ruleSet.dataCutoff).toLocaleString()}</p>
                </div>
                {ruleSet.status === "shadow" && <Button size="sm" onClick={() => { setAction({ kind: "promote", version: ruleSet.ruleVersion }); setConfirmation(""); }}>Review activation</Button>}
                {ruleSet.status === "active" && <Button size="sm" variant="destructive" disabled={transition.isPending} onClick={() => transition.mutate({ kind: "suspend", version: ruleSet.ruleVersion, reason: "Suspended from Learning & Evidence." })}><PauseCircle className="mr-2 h-3.5 w-3.5" />Suspend now</Button>}
                {ruleSet.status === "suspended" && <Button size="sm" variant="outline" onClick={() => { setAction({ kind: "rollback", version: ruleSet.ruleVersion }); setConfirmation(""); }}>Review rollback</Button>}
              </div>
            </div>
          ))}
          {data.ruleSets.length === 0 && <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No version has earned an improved out-of-sample verdict. Run validation after the record is large enough.</p>}

          {action && (
            <div className="rounded-lg border border-warning/40 bg-warning/5 p-4">
              <p className="font-medium">{action.kind === "promote" ? "Activate validated evidence" : "Roll back to a validated version"}</p>
              <p className="mt-1 text-sm text-muted-foreground">This authorizes the exact version below to withhold matching candidates on the current {data.executionTarget} account. It cannot originate trades, raise conviction, or expand risk.</p>
              <p className="mt-2 break-all font-mono text-xs">{action.version}</p>
              <label className="mt-4 block text-xs text-muted-foreground">Type <span className="font-mono text-foreground">{expectedPhrase}</span> to confirm</label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" aria-label="Lifecycle confirmation" />
                <Button disabled={confirmation !== expectedPhrase || transition.isPending} onClick={() => transition.mutate({
                  kind: action.kind,
                  version: action.version,
                  confirmation,
                })}>{transition.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}{action.kind === "promote" ? "Activate exact version" : "Rollback exact version"}</Button>
                <Button variant="ghost" onClick={() => { setAction(null); setConfirmation(""); }}>Cancel</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="rounded-md border p-4 text-xs text-muted-foreground">
        {data.snapshot.limitations.map((limitation) => <p key={limitation}>• {limitation}</p>)}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-mono text-lg font-semibold">{value}</p></div>;
}

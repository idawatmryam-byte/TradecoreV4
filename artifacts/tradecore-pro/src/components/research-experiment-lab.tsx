import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetResearchExperimentQueryKey,
  getListResearchExperimentsQueryKey,
  getListResearchReplayEventsQueryKey,
  useCancelResearchExperiment,
  useCreateResearchExperiment,
  useGetResearchExperiment,
  useListResearchExperiments,
  useListResearchReplayEvents,
  type ResearchExperiment,
  type ResearchMetrics,
  type ResearchPromotionReport,
} from "@workspace/api-client-react";
import { useSection } from "@/lib/section";
import { cn, formatCurrency, formatPercent } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Clock3, FlaskConical, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

function dateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function initialDates() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 90);
  return { start: dateInput(start), end: dateInput(end) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The Research request failed. Review the bounded window and provider data, then retry.";
}

function metric(value: number | null | undefined, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits);
}

function ComparisonMetric({ label, control, candidate }: { label: string; control: string; candidate: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-border/60 py-2.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-20 text-right font-mono">{control}</span>
      <span className="min-w-20 text-right font-mono text-primary">{candidate}</span>
    </div>
  );
}

function MetricsComparison({ report }: { report: ResearchPromotionReport }) {
  const control = report.control;
  const candidate = report.candidate;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>Control / candidate</span>
          <span className="grid grid-cols-2 gap-5 text-xs font-normal text-muted-foreground">
            <span>Brain V0</span><span className="text-primary">Full brain</span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ComparisonMetric label="Net P/L" control={formatCurrency(control.netPnl)} candidate={formatCurrency(candidate.netPnl)} />
        <ComparisonMetric label="Modeled costs" control={formatCurrency(control.costs)} candidate={formatCurrency(candidate.costs)} />
        <ComparisonMetric label="Maximum drawdown" control={formatPercent(control.maxDrawdown)} candidate={formatPercent(candidate.maxDrawdown)} />
        <ComparisonMetric label="Closed trades" control={String(control.closedTrades)} candidate={String(candidate.closedTrades)} />
        <ComparisonMetric label="Eligible decisions" control={String(control.eligibleDecisions)} candidate={String(candidate.eligibleDecisions)} />
        <ComparisonMetric label="Net expectancy" control={`${metric(control.netExpectancyR, 3)}R`} candidate={`${metric(candidate.netExpectancyR, 3)}R`} />
        <ComparisonMetric
          label="95% expectancy interval"
          control={`${metric(control.uncertainty.lowerNetExpectancyR, 3)}…${metric(control.uncertainty.upperNetExpectancyR, 3)}R`}
          candidate={`${metric(candidate.uncertainty.lowerNetExpectancyR, 3)}…${metric(candidate.uncertainty.upperNetExpectancyR, 3)}R`}
        />
      </CardContent>
    </Card>
  );
}

function ExperimentForm({ onStarted }: { onStarted: (id: number) => void }) {
  const { section } = useSection();
  const dates = useMemo(initialDates, []);
  const [name, setName] = useState("Full-brain validation");
  const [symbols, setSymbols] = useState(section === "forex" ? "EUR_USD" : "BTCUSDT");
  const [startDate, setStartDate] = useState(dates.start);
  const [endDate, setEndDate] = useState(dates.end);
  const [folds, setFolds] = useState(3);
  const [holdoutFraction, setHoldoutFraction] = useState(0.2);
  const [purgeMinutes, setPurgeMinutes] = useState(60);
  const [embargoMinutes, setEmbargoMinutes] = useState(60);
  const queryClient = useQueryClient();
  const mutation = useCreateResearchExperiment();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    mutation.mutate({ data: {
      name,
      symbols: symbols.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
      timeframe: "1m",
      startDate: new Date(`${startDate}T00:00:00.000Z`).toISOString(),
      endDate: new Date(`${endDate}T00:00:00.000Z`).toISOString(),
      marketType: section === "forex" ? "forex" : "spot",
      startingBalance: 10_000,
      positionSizeUsdt: 100,
      maxOpenPositions: 2,
      dailyLossLimitUsdt: 500,
      leverage: 1,
      folds,
      holdoutFraction,
      purgeMinutes,
      embargoMinutes,
      deterministicSeed: 42,
      falseDiscoveryRate: 0.05,
      candidateBrainVersion: "phase8-full-brain-v1",
      maxPortfolioRiskPercent: 10,
      maxSymbolConcentrationPercent: 100,
      maxNetExposurePercent: 200,
      maxCorrelatedExposurePercent: 200,
      correlationThreshold: 0.7,
      correlationUnknownPolicy: "allow",
    } }, {
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: getListResearchExperimentsQueryKey() });
        onStarted(result.id);
      },
    });
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">New scientific experiment</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <label className="block space-y-1 text-sm"><span className="text-muted-foreground">Name</span><input required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded border bg-background px-3 py-2" /></label>
          <label className="block space-y-1 text-sm"><span className="text-muted-foreground">Frozen universe</span><input required value={symbols} onChange={(event) => setSymbols(event.target.value)} className="w-full rounded border bg-background px-3 py-2 font-mono" /><span className="block text-xs text-muted-foreground">Comma-separated, maximum 10. The universe is frozen before replay.</span></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm"><span className="text-muted-foreground">Start</span><input type="date" required value={startDate} onChange={(event) => setStartDate(event.target.value)} className="w-full rounded border bg-background px-3 py-2" /></label>
            <label className="space-y-1 text-sm"><span className="text-muted-foreground">End</span><input type="date" required value={endDate} onChange={(event) => setEndDate(event.target.value)} className="w-full rounded border bg-background px-3 py-2" /></label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm"><span className="text-muted-foreground">Walk-forward folds</span><input type="number" min={1} max={10} value={folds} onChange={(event) => setFolds(Number(event.target.value))} className="w-full rounded border bg-background px-3 py-2" /></label>
            <label className="space-y-1 text-sm"><span className="text-muted-foreground">Untouched holdout</span><input type="number" min={0.1} max={0.5} step={0.05} value={holdoutFraction} onChange={(event) => setHoldoutFraction(Number(event.target.value))} className="w-full rounded border bg-background px-3 py-2" /></label>
            <label className="space-y-1 text-sm"><span className="text-muted-foreground">Purge (minutes)</span><input type="number" min={0} max={10080} value={purgeMinutes} onChange={(event) => setPurgeMinutes(Number(event.target.value))} className="w-full rounded border bg-background px-3 py-2" /></label>
            <label className="space-y-1 text-sm"><span className="text-muted-foreground">Embargo (minutes)</span><input type="number" min={0} max={10080} value={embargoMinutes} onChange={(event) => setEmbargoMinutes(Number(event.target.value))} className="w-full rounded border bg-background px-3 py-2" /></label>
          </div>
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-muted-foreground">
            Provider candles are untrusted inputs and are validated. Synthetic fallback is refused. Jobs are bounded to 80,000 estimated decision/management events and 100,000 persisted replay events.
          </div>
          {mutation.isError && <div role="alert" className="text-sm text-destructive">{errorMessage(mutation.error)}</div>}
          <Button type="submit" disabled={mutation.isPending} className="w-full gap-2"><FlaskConical className="h-4 w-4" />{mutation.isPending ? "Preparing…" : "Run full-brain experiment"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ExperimentList({ experiments, selectedId, onSelect }: { experiments: ResearchExperiment[]; selectedId: number | null; onSelect: (id: number) => void }) {
  if (experiments.length === 0) return <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No scientific experiments yet.</div>;
  return <div className="space-y-2">{experiments.map((experiment) => (
    <button key={experiment.id} onClick={() => onSelect(experiment.id)} className={cn("w-full rounded-lg border p-3 text-left transition-colors", selectedId === experiment.id ? "border-primary bg-primary/5" : "hover:bg-muted/50")}>
      <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{experiment.name}</span><Badge variant={experiment.status === "completed" ? "success" : experiment.status === "failed" ? "destructive" : "secondary"}>{experiment.status}</Badge></div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground"><span>{experiment.stage}</span><span>{experiment.progress}%</span></div>
      <Progress value={experiment.progress} className="mt-1.5 h-1.5" />
    </button>
  ))}</div>;
}

function ExperimentDetail({ id }: { id: number }) {
  const queryClient = useQueryClient();
  const detail = useGetResearchExperiment(id, { query: {
    queryKey: getGetResearchExperimentQueryKey(id),
    refetchInterval: (query) => ["preparing", "pending", "running"].includes(query.state.data?.status ?? "") ? 2500 : false,
  } });
  const replayParams = { afterSequence: -1, limit: 100 };
  const replay = useListResearchReplayEvents(id, replayParams, { query: {
    queryKey: getListResearchReplayEventsQueryKey(id, replayParams),
    enabled: Boolean(detail.data?.decisionEventCount || detail.data?.managementEventCount),
  } });
  const cancel = useCancelResearchExperiment();
  const experiment = detail.data;
  if (detail.isLoading) return <div className="rounded-lg border p-10 text-center text-sm text-muted-foreground">Loading experiment…</div>;
  if (detail.isError || !experiment) return <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">Experiment detail could not be loaded.</div>;
  const active = ["preparing", "pending", "running"].includes(experiment.status);
  const report = experiment.report;
  return <div className="space-y-4">
    <Card><CardContent className="pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h2 className="text-lg font-semibold">{experiment.name}</h2><Badge variant="outline">Research only</Badge></div><p className="mt-1 text-xs font-mono text-muted-foreground">{experiment.experimentId ?? "Manifest preparation in progress"}</p></div>{active && <Button variant="outline" size="sm" disabled={cancel.isPending || experiment.cancelRequested} onClick={() => cancel.mutate({ id }, { onSuccess: () => void queryClient.invalidateQueries({ queryKey: getGetResearchExperimentQueryKey(id) }) })}>{experiment.cancelRequested ? "Cancellation requested" : "Cancel"}</Button>}</div>
      <div className="mt-4"><div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>{experiment.stage}</span><span>{experiment.progress}%</span></div><Progress value={experiment.progress} /></div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><div><div className="text-xs text-muted-foreground">Decisions</div><div className="font-mono">{experiment.decisionEventCount}</div></div><div><div className="text-xs text-muted-foreground">Management</div><div className="font-mono">{experiment.managementEventCount}</div></div><div><div className="text-xs text-muted-foreground">Status</div><div>{experiment.status}</div></div><div><div className="text-xs text-muted-foreground">Authority</div><div>None</div></div></div>
      {experiment.error && <div role="alert" className="mt-4 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{experiment.error}</div>}
    </CardContent></Card>

    {report ? <>
      <div className={cn("rounded-lg border p-4", report.recommendation === "ELIGIBLE_FOR_HUMAN_REVIEW" ? "border-success/50 bg-success/10" : report.recommendation === "REJECT" ? "border-destructive/50 bg-destructive/10" : "border-warning/50 bg-warning/10")}>
        <div className="flex items-center gap-2 font-medium">{report.recommendation === "ELIGIBLE_FOR_HUMAN_REVIEW" ? <CheckCircle2 className="h-5 w-5" /> : report.recommendation === "REJECT" ? <XCircle className="h-5 w-5" /> : <Clock3 className="h-5 w-5" />}{report.recommendation.replaceAll("_", " ")}</div>
        <p className="mt-1 text-sm text-muted-foreground">Human approval remains mandatory. This report cannot promote a brain, alter risk policy, or execute a trade.</p>
      </div>
      <MetricsComparison report={report} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle className="text-base">Predetermined gates</CardTitle></CardHeader><CardContent className="space-y-2">{report.gateChecks.map((gate) => <div key={gate.key} className="flex items-start gap-2 rounded border p-2.5 text-sm">{gate.passed ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}<div><div className="font-medium">{gate.key}</div><div className="text-xs text-muted-foreground">{gate.actual} · required: {gate.required}</div></div></div>)}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Attribution</CardTitle></CardHeader><CardContent className="space-y-2">{Object.entries(report.attribution).filter(([, value]) => typeof value === "number").map(([key, value]) => <div key={key} className="flex justify-between border-b py-2 text-sm last:border-0"><span className="capitalize text-muted-foreground">{key.replaceAll(/([A-Z])/g, " $1")}</span><span className="font-mono">{formatCurrency(value as number)}</span></div>)}</CardContent></Card>
      </div>
    </> : active ? <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground"><RefreshCw className="mx-auto mb-3 h-5 w-5 animate-spin" />The control/candidate replay and predeclared stress suite are running.</div> : null}

    <Card><CardHeader><CardTitle className="flex items-center justify-between text-base"><span>Decision replay</span><Badge variant="secondary">First 100 events</Badge></CardTitle></CardHeader><CardContent>
      {replay.isLoading ? <div className="py-8 text-center text-sm text-muted-foreground">Loading replay…</div> : replay.data?.events.length ? <div className="max-h-[420px] overflow-auto"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-card text-muted-foreground"><tr><th className="p-2">Seq</th><th className="p-2">Time</th><th className="p-2">Partition</th><th className="p-2">Layer</th><th className="p-2">Subject</th><th className="p-2">Outcome / action</th></tr></thead><tbody>{replay.data.events.map((item) => <tr key={`${item.kind}-${item.sequence}`} className="border-t"><td className="p-2 font-mono">{item.sequence}</td><td className="p-2 whitespace-nowrap">{new Date(item.observedAt).toLocaleString()}</td><td className="p-2">{item.partitionId}</td><td className="p-2">{item.kind}</td><td className="p-2 font-mono">{item.symbol ?? `trade ${item.tradeId}`}</td><td className="p-2">{String(item.event.outcome ?? item.event.proposedAction ?? "—")}</td></tr>)}</tbody></table></div> : <div className="py-8 text-center text-sm text-muted-foreground">Replay events appear after validated frames are persisted.</div>}
    </CardContent></Card>
  </div>;
}

export function ResearchExperimentLab() {
  const queryClient = useQueryClient();
  const { section } = useSection();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const list = useListResearchExperiments({ query: {
    queryKey: getListResearchExperimentsQueryKey(),
    refetchInterval: (query) => query.state.data?.some((item) => ["preparing", "pending", "running"].includes(item.status)) ? 3000 : 15000,
  } });
  return <div className="space-y-5">
    <div className="flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/10 p-4"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><div className="font-medium">Research has zero execution authority</div><p className="mt-1 text-sm text-muted-foreground">Full-brain replay is isolated from Demo and Live executors. AI output cannot change measurements, partitions, labels, gates, or promotion state.</p></div></div>
    <div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold">Scientific validation</h2><p className="text-sm text-muted-foreground">Purged walk-forward validation, untouched holdout, golden replay, stress testing, and Brain V0 comparison.</p></div><Button variant="ghost" size="sm" onClick={() => void queryClient.invalidateQueries({ queryKey: getListResearchExperimentsQueryKey() })}><RefreshCw className="h-4 w-4" /></Button></div>
    <div className="grid items-start gap-5 lg:grid-cols-[340px_1fr]"><div className="space-y-4"><ExperimentForm key={section} onStarted={setSelectedId} /><ExperimentList experiments={list.data ?? []} selectedId={selectedId} onSelect={setSelectedId} />{list.isError && <div role="alert" className="flex gap-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="h-4 w-4 shrink-0" />Experiments could not be loaded.</div>}</div><div>{selectedId ? <ExperimentDetail id={selectedId} /> : <div className="flex min-h-[420px] items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">Create or select an experiment to inspect its evidence.</div>}</div></div>
  </div>;
}

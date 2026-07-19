/**
 * Optimization Autopsy — "what's wrong with MY configuration?"
 *
 * Launches a walk-forward parameter diagnosis for one strategy and renders
 * the report: verdict banner, Current vs Suggested validation metrics, and
 * evidence-backed findings with a one-click apply. The three verdicts
 * (improved / no_better / insufficient_data) are all first-class — telling
 * the user their tuning is NOT the problem is a valid diagnosis.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useStartAutopsy, useListAutopsies, getListAutopsiesQueryKey,
  useGetStrategies, getGetStrategiesQueryKey,
  useUpdateStrategyConfig,
  type AutopsyRun, type AutopsyDiagnosis, type AutopsyParams, type AutopsyWindowMetrics,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Button } from "@/components/ui";
import { Stethoscope, ChevronDown, ChevronUp, Loader2, CheckCircle2, MinusCircle, AlertTriangle } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

const fmtPct = (x?: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const fmtPf = (x?: number | null) => (x == null ? "—" : x >= 999 ? "∞" : x.toFixed(2));
const fmtHold = (s?: number | null) =>
  s == null ? "—" : s % 3600 === 0 ? `${s / 3600}h` : `${Math.round(s / 60)}min`;

function MetricRow({ label, cur, best, goodWhenHigher = true }: {
  label: string; cur: string; best: string; goodWhenHigher?: boolean;
}) {
  const curN = parseFloat(cur); const bestN = parseFloat(best);
  const bestWins = !isNaN(curN) && !isNaN(bestN) && (goodWhenHigher ? bestN > curN : bestN < curN);
  return (
    <div className="grid grid-cols-[1fr_auto_auto] gap-x-6 py-1.5 border-b border-border/40 text-sm font-mono">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("nums text-right w-20", !bestWins && "text-foreground font-semibold")}>{cur}</span>
      <span className={cn("nums text-right w-20", bestWins && "text-success font-semibold")}>{best}</span>
    </div>
  );
}

function ReportView({ run }: { run: AutopsyRun }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateConfig = useUpdateStrategyConfig();
  const diagnosis = run.diagnosis as AutopsyDiagnosis | null;
  const cur = run.currentVal as AutopsyWindowMetrics | null;
  const best = run.bestVal as AutopsyWindowMetrics | null;
  const bestParams = run.bestParams as AutopsyParams | null;
  const curParams = run.currentParams as AutopsyParams;

  const applySuggestion = () => {
    if (!bestParams) return;
    updateConfig.mutate(
      {
        id: run.strategyId,
        data: {
          ...(bestParams.maxLossUsdt != null && { maxLossUsdt: bestParams.maxLossUsdt }),
          ...(bestParams.targetProfitUsdt != null && { targetProfitUsdt: bestParams.targetProfitUsdt }),
          confidenceThreshold: bestParams.confidenceThreshold,
          maxHoldingSeconds: bestParams.maxHoldingSeconds,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
          toast({
            title: "Suggested configuration applied",
            description: `${run.strategyName ?? run.strategyId} now uses the validated parameters. Watch it on paper trading before trusting it with real funds.`,
          });
        },
        onError: () => toast({ title: "Error", description: "Failed to apply the configuration.", variant: "destructive" }),
      },
    );
  };

  if (run.status === "failed") {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <div className="flex items-center gap-2 font-semibold text-destructive"><AlertTriangle className="h-4 w-4" /> Autopsy failed</div>
        <p className="mt-1 text-muted-foreground font-mono text-xs">{run.error ?? "Unknown error"}</p>
      </div>
    );
  }

  if (run.status !== "completed") {
    return (
      <div className="rounded-md border bg-muted/20 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          {run.stage ?? "Queued…"}
        </div>
        <div className="mt-3 h-2 rounded bg-muted overflow-hidden">
          <div className="h-full bg-primary transition-all" style={{ width: `${run.progress}%` }} />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground font-mono">
          Running the live-parity backtest engine across parameter candidates — typically 3–10 minutes.
        </p>
      </div>
    );
  }

  const verdictUi = {
    improved: { icon: CheckCircle2, cls: "border-success/40 bg-success/10 text-success", label: "Better configuration found — validated out-of-sample" },
    no_better: { icon: MinusCircle, cls: "border-border bg-muted/30 text-foreground", label: "Your configuration is not the problem" },
    insufficient_data: { icon: AlertTriangle, cls: "border-warning/40 bg-warning/10 text-warning", label: "Not enough trades to judge" },
  }[diagnosis?.verdict ?? "insufficient_data"];
  const VerdictIcon = verdictUi.icon;

  return (
    <div className="space-y-4">
      <div className={cn("rounded-md border p-4", verdictUi.cls)}>
        <div className="flex items-center gap-2 font-semibold text-sm"><VerdictIcon className="h-4 w-4" /> {verdictUi.label}</div>
        <p className="mt-2 text-sm text-foreground/90">{diagnosis?.summary}</p>
        {run.truncated && (
          <p className="mt-2 text-[11px] font-mono text-muted-foreground">
            Note: the sweep hit its 10-minute budget — coverage was narrower than planned, results remain valid.
          </p>
        )}
      </div>

      {diagnosis?.verdict === "improved" && cur && best && (
        <>
          <div className="rounded-md border p-4">
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-6 pb-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              <span>Validation window (never used for fitting)</span>
              <span className="text-right w-20">Current</span>
              <span className="text-right w-20">Suggested</span>
            </div>
            <MetricRow label="Profit factor" cur={fmtPf(cur.profitFactor)} best={fmtPf(best.profitFactor)} />
            <MetricRow label="Win rate" cur={fmtPct(cur.winRate)} best={fmtPct(best.winRate)} />
            <MetricRow label="Trades" cur={String(cur.totalTrades)} best={String(best.totalTrades)} />
            <MetricRow label="Max drawdown" cur={fmtPct(cur.maxDrawdown)} best={fmtPct(best.maxDrawdown)} goodWhenHigher={false} />
            <MetricRow label="Net P&L ($1k start)" cur={cur.totalPnl.toFixed(2)} best={best.totalPnl.toFixed(2)} />
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-6 pt-2 text-xs font-mono text-muted-foreground">
              <span>Parameters</span>
              <span className="text-right">
                ${curParams.maxLossUsdt ?? "—"} / ${curParams.targetProfitUsdt ?? "—"} · conf {curParams.confidenceThreshold} · {fmtHold(curParams.maxHoldingSeconds)}
              </span>
              <span className="text-right text-success">
                ${bestParams?.maxLossUsdt ?? "—"} / ${bestParams?.targetProfitUsdt ?? "—"} · conf {bestParams?.confidenceThreshold} · {fmtHold(bestParams?.maxHoldingSeconds)}
              </span>
            </div>
          </div>

          {(diagnosis.findings ?? []).map((f) => (
            <div key={f.param} className="rounded-md border border-primary/25 bg-primary/5 p-4">
              <div className="text-xs font-mono uppercase tracking-wider text-primary">📋 {f.label}</div>
              <p className="mt-1.5 text-sm">{f.evidence}</p>
              <p className="mt-1.5 text-xs font-mono text-muted-foreground">{f.action}</p>
            </div>
          ))}

          <Button onClick={applySuggestion} disabled={updateConfig.isPending} className="gap-2">
            {updateConfig.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Apply suggested configuration
          </Button>
        </>
      )}
    </div>
  );
}

export function AutopsyPanel({ initialStrategyId }: { initialStrategyId?: string } = {}) {
  // Arriving via the Strategies page's "Diagnose" link opens the panel
  // pre-selected on that strategy — no need to hunt for it again.
  const [open, setOpen] = useState(!!initialStrategyId);
  const [strategyId, setStrategyId] = useState(initialStrategyId ?? "");
  const [days, setDays] = useState(45);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: strategies } = useGetStrategies({ query: { queryKey: getGetStrategiesQueryKey(), enabled: open } });
  const { data: autopsies } = useListAutopsies({
    query: {
      queryKey: getListAutopsiesQueryKey(),
      enabled: open,
      refetchInterval: (query) => {
        const list = query.state.data as AutopsyRun[] | undefined;
        return list?.some((a) => a.status === "running" || a.status === "pending") ? 3000 : false;
      },
    },
  });
  const startAutopsy = useStartAutopsy();

  const selected: AutopsyRun | null = useMemo(() => {
    if (!autopsies || autopsies.length === 0) return null;
    // A run the user explicitly picked (history pill, or just-started run)
    // always wins. Otherwise default to the most recent run for the
    // CURRENTLY SELECTED strategy — never another strategy's report, which
    // would silently mislead (e.g. arriving via "Diagnose" on Trend Pullback
    // must never show a stale Scalp Reversion verdict underneath it).
    const explicit = autopsies.find((a) => a.id === selectedId);
    if (explicit) return explicit;
    return autopsies.find((a) => a.strategyId === strategyId) ?? null;
  }, [autopsies, selectedId, strategyId]);

  const run = () => {
    if (!strategyId) return;
    startAutopsy.mutate(
      { data: { strategyId, days } },
      {
        onSuccess: (res) => {
          setSelectedId(res.id);
          queryClient.invalidateQueries({ queryKey: getListAutopsiesQueryKey() });
        },
        onError: (err) =>
          toast({ title: "Could not start autopsy", description: String((err as Error)?.message ?? err), variant: "destructive" }),
      },
    );
  };

  const anyRunning = autopsies?.some((a) => a.status === "running" || a.status === "pending") ?? false;

  return (
    <Card>
      <CardHeader className="cursor-pointer select-none" onClick={() => setOpen((v) => !v)}>
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-primary" />
            Optimization Autopsy
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-normal">
              what's wrong with my configuration?
            </span>
          </span>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Sweeps one strategy's real knobs — dollar risk & target, confidence, hold time — with the live-parity
            backtest engine, then <strong>walk-forward validates</strong>: a suggestion only appears if it beat your
            current configuration on a later window it was never fitted to. Honest by design: "your settings are fine"
            is a possible answer.
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Strategy</label>
              <select
                value={strategyId}
                onChange={(e) => { setStrategyId(e.target.value); setSelectedId(null); }}
                className="block bg-background border border-border rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">Select strategy…</option>
                {strategies?.map((s) => (
                  <option key={s.strategyId} value={s.strategyId}>{s.strategyName}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Window</label>
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="block bg-background border border-border rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value={30}>30 days (20 train / 10 validate)</option>
                <option value={45}>45 days (30 train / 15 validate)</option>
                <option value={60}>60 days (40 train / 20 validate)</option>
                <option value={90}>90 days (60 train / 30 validate)</option>
              </select>
            </div>
            <Button onClick={run} disabled={!strategyId || startAutopsy.isPending || anyRunning} className="gap-2">
              {startAutopsy.isPending || anyRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
              {anyRunning ? "Autopsy running…" : "Run Autopsy"}
            </Button>
          </div>

          {autopsies && autopsies.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {autopsies.slice(0, 8).map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSelectedId(a.id)}
                  className={cn(
                    "px-2 py-1 rounded text-[11px] font-mono border transition-colors",
                    selected?.id === a.id
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/50",
                  )}
                >
                  #{a.id} {a.strategyName ?? a.strategyId}
                  {a.status === "completed"
                    ? a.verdict === "improved" ? " ✓" : a.verdict === "no_better" ? " ·" : " ?"
                    : a.status === "failed" ? " ✗" : " …"}
                </button>
              ))}
            </div>
          )}

          {selected ? (
            <ReportView run={selected} />
          ) : (
            strategyId && (
              <p className="text-xs text-muted-foreground border border-dashed rounded-md p-3">
                No autopsy has been run for this strategy yet — press "Run Autopsy" above.
              </p>
            )
          )}
        </CardContent>
      )}
    </Card>
  );
}

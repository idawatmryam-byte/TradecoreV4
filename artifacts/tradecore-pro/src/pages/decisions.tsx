import { useState } from "react";
import {
  useGetDecisionJournal, getGetDecisionJournalQueryKey, getDecisionJournal,
  type StrategyDecisionEntry,
} from "@workspace/api-client-react";
import { Card, CardContent, Button, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  Scale, CheckCircle2, XCircle, PauseCircle, ChevronDown, ChevronUp, Loader2,
  ArrowUpRight, ArrowDownRight, Eye, LineChart, ShieldCheck, Clock,
} from "lucide-react";

/**
 * Decisions — the strategy journal. Every trade the brains genuinely
 * considered: executed (with its full written plan), approved but not taken
 * (and which engine gate stopped it), or rejected by the strategy's own
 * reasoning. This is the page that shows the engine THINKING — including why
 * it is NOT trading.
 */

type Kind = "all" | "executed" | "approved_not_taken" | "rejected";

const KIND_META: Record<Exclude<Kind, "all">, { label: string; icon: typeof CheckCircle2; className: string }> = {
  executed: { label: "Executed", icon: CheckCircle2, className: "bg-success/15 text-success border-success/40" },
  approved_not_taken: { label: "Approved · not taken", icon: PauseCircle, className: "bg-warning/15 text-warning border-warning/40" },
  rejected: { label: "Rejected", icon: XCircle, className: "bg-destructive/10 text-destructive border-destructive/40" },
};

/** The stored report is either a DecisionReport (rejections) or a full
 *  TradePlan whose `.report` holds the DecisionReport (approved/executed). */
function unpack(entry: StrategyDecisionEntry): { report: any | null; plan: any | null } {
  const raw = entry.report as any;
  if (!raw || typeof raw !== "object") return { report: null, plan: null };
  if (raw.report && typeof raw.report === "object") return { report: raw.report, plan: raw };
  return { report: raw, plan: null };
}

function ReportSection({ title, icon: Icon, lines }: { title: string; icon: typeof Eye; lines?: string[] }) {
  if (!lines || lines.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-1.5">
        <Icon className="h-3.5 w-3.5" /> {title}
      </div>
      <ul className="space-y-1">
        {lines.map((l, i) => (
          <li key={i} className="text-xs leading-relaxed pl-3 border-l border-border">{l}</li>
        ))}
      </ul>
    </div>
  );
}

function DecisionCard({ entry }: { entry: StrategyDecisionEntry }) {
  const [open, setOpen] = useState(false);
  const meta = KIND_META[entry.kind as Exclude<Kind, "all">] ?? KIND_META.rejected;
  const KindIcon = meta.icon;
  const { report, plan } = unpack(entry);
  const isShort = entry.side === "short";
  const when = new Date(entry.lastSeenAt ?? entry.createdAt);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-muted/40 transition-colors"
      >
        <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-mono font-semibold shrink-0", meta.className)}>
          <KindIcon className="h-3.5 w-3.5" /> {meta.label}
        </span>
        <span className="font-mono font-bold text-sm shrink-0">{entry.symbol}</span>
        {entry.side && (
          <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-mono font-semibold shrink-0", isShort ? "text-destructive" : "text-success")}>
            {isShort ? <ArrowDownRight className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
            {isShort ? "SHORT" : "LONG"}
          </span>
        )}
        <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
          {entry.strategyName ?? entry.strategyId}
          {entry.reason ? ` — ${entry.reason}` : report?.summary ? ` — ${report.summary}` : ""}
        </span>
        {entry.occurrences > 1 && (
          <Badge variant="outline" className="font-mono text-[10px] shrink-0">×{entry.occurrences}</Badge>
        )}
        {entry.confidence != null && (
          <span className="text-[11px] font-mono text-muted-foreground shrink-0">{Number(entry.confidence).toFixed(0)}%</span>
        )}
        <span className="text-[11px] font-mono text-muted-foreground shrink-0 hidden sm:inline">
          {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <CardContent className="border-t border-border pt-4 pb-4 space-y-4">
          {entry.stage && (
            <p className="text-xs">
              <span className="font-mono uppercase tracking-wider text-muted-foreground">Stage:</span>{" "}
              <span className="font-mono">{entry.stage}</span>
            </p>
          )}
          {report?.summary && (
            <p className="text-sm leading-relaxed">{report.summary}</p>
          )}
          {plan && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 font-mono text-xs">
              <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</div>{Number(plan.entryPrice).toPrecision(6)}</div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground">Stop</div><span className="text-destructive">{Number(plan.slPrice).toPrecision(6)}</span></div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground">Target</div><span className="text-success">{Number(plan.tpPrice).toPrecision(6)}</span></div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground">Leverage</div>{plan.leverage}×</div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <ReportSection title="Market view" icon={Eye} lines={report?.marketView} />
            <ReportSection title="Entry logic" icon={LineChart} lines={report?.entryLogic} />
            <ReportSection title="Risk logic" icon={ShieldCheck} lines={report?.riskLogic} />
            <ReportSection title="Exit logic" icon={Clock} lines={report?.exitLogic} />
          </div>
          {Array.isArray(report?.checks) && report.checks.length > 0 && (
            <div>
              <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-1.5">Checks</div>
              <div className="space-y-1">
                {report.checks.map((c: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    {c.passed
                      ? <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
                      : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />}
                    <span className="font-medium shrink-0">{c.name}</span>
                    <span className="text-muted-foreground">{c.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {entry.tradeId != null && (
            <p className="text-[11px] font-mono text-muted-foreground">Executed as trade #{entry.tradeId}</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export function Decisions() {
  const [kind, setKind] = useState<Kind>("all");
  const [extra, setExtra] = useState<StrategyDecisionEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const params = kind === "all" ? {} : { kind: kind as Exclude<Kind, "all"> };
  const { data: firstPage, isLoading, isError } = useGetDecisionJournal(params, {
    query: { refetchInterval: 15000, queryKey: getGetDecisionJournalQueryKey(params) },
  });

  const entries = [...(firstPage ?? []), ...extra];
  const lastId = entries.length ? entries[entries.length - 1]!.id : undefined;

  async function loadMore() {
    if (!lastId) return;
    setLoadingMore(true);
    try {
      const older = await getDecisionJournal({ ...params, before: lastId });
      if (!older || older.length === 0) setExhausted(true);
      else setExtra((prev) => [...prev, ...older]);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Scale className="h-5 w-5 text-primary" /> Decisions
          </h1>
          <p className="text-xs text-muted-foreground mt-1 max-w-xl">
            The strategies' written journal — every trade they considered, with the full reasoning.
            Rejections matter as much as entries: this is why the engine is (or isn't) trading.
          </p>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {(["all", "executed", "approved_not_taken", "rejected"] as Kind[]).map((k) => (
            <Button
              key={k}
              size="sm"
              variant={kind === k ? "default" : "outline"}
              className="text-xs h-7"
              onClick={() => { setKind(k); setExtra([]); setExhausted(false); }}
            >
              {k === "all" ? "All" : KIND_META[k as Exclude<Kind, "all">].label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      )}
      {isError && (
        <p className="text-sm text-destructive text-center py-8">Couldn't load the decision journal.</p>
      )}
      {!isLoading && !isError && entries.length === 0 && (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
          No recorded decisions yet. Once the engine scans with the decision-making strategies enabled,
          every considered trade — taken or passed — appears here with its reasoning.
        </CardContent></Card>
      )}

      <div className="space-y-2">
        {entries.map((e) => <DecisionCard key={e.id} entry={e} />)}
      </div>

      {entries.length > 0 && !exhausted && (
        <div className="flex justify-center pb-6">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load older decisions"}
          </Button>
        </div>
      )}
    </div>
  );
}

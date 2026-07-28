import { useState } from "react";
import {
  useGetJournal, getGetJournalQueryKey, getJournal,
  type JournalEntry,
} from "@workspace/api-client-react";
import { Card, CardContent, Button, Badge } from "@/components/ui";
import { PageHeader, PageTabs, EmptyState, LoadingRows } from "@/components/patterns";
import { PORTFOLIO_TABS } from "./trades";
import { cn } from "@/lib/utils";
import {
  BookOpen, CheckCircle2, XCircle, MinusCircle, ChevronDown, ChevronUp, Loader2,
  ArrowUpRight, ArrowDownRight, ListChecks, Download,
} from "lucide-react";

/**
 * Journal — the per-trade post-mortem. tradeAnalysesTable is generated
 * automatically and deterministically the moment a live trade closes
 * (lib/tradeAnalysis.ts) — this page is a read-only window onto facts the
 * engine already computed, never a fresh narrative. Grade and findings are
 * a scorecard of what happened, not a prediction about what's next.
 */

type Outcome = "all" | "win" | "loss" | "breakeven";

const OUTCOME_META: Record<Exclude<Outcome, "all">, { label: string; icon: typeof CheckCircle2; className: string }> = {
  win: { label: "Win", icon: CheckCircle2, className: "bg-success/15 text-success border-success/40" },
  loss: { label: "Loss", icon: XCircle, className: "bg-destructive/10 text-destructive border-destructive/40" },
  breakeven: { label: "Breakeven", icon: MinusCircle, className: "bg-muted text-muted-foreground border-border" },
};

const GRADE_COLOR: Record<string, string> = {
  A: "text-success", B: "text-success", C: "text-muted-foreground", D: "text-warning", F: "text-destructive",
};

function JournalCard({ entry }: { entry: JournalEntry }) {
  const [open, setOpen] = useState(false);
  const meta = OUTCOME_META[entry.outcome as Exclude<Outcome, "all">] ?? OUTCOME_META.breakeven;
  const OutcomeIcon = meta.icon;
  // trades.side is the OPEN order side ("buy"/"sell"), not "long"/"short" —
  // side="sell" opens a short (futures only); see lib/db/schema/trades.ts.
  const isShort = entry.side === "sell";
  const when = new Date(entry.exitTime ?? entry.entryTime);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-muted/40 transition-colors"
      >
        <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-mono font-semibold shrink-0", meta.className)}>
          <OutcomeIcon className="h-3.5 w-3.5" /> {meta.label}
        </span>
        <span className="font-mono font-bold text-sm shrink-0">{entry.symbol}</span>
        <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-mono font-semibold shrink-0", isShort ? "text-destructive" : "text-success")}>
          {isShort ? <ArrowDownRight className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
          {isShort ? "SHORT" : "LONG"}
        </span>
        <span className="text-[13px] text-muted-foreground truncate flex-1 min-w-0">
          {entry.strategyName ?? entry.strategyId} — {entry.summary}
        </span>
        {entry.grade && (
          <Badge variant="outline" className={cn("font-mono text-[11px] shrink-0 font-bold", GRADE_COLOR[entry.grade] ?? "")}>
            {entry.grade}
          </Badge>
        )}
        {entry.rMultiple != null && (
          <span className={cn("text-[11px] font-mono font-semibold shrink-0", entry.rMultiple >= 0 ? "text-success" : "text-destructive")}>
            {entry.rMultiple >= 0 ? "+" : ""}{entry.rMultiple.toFixed(2)}R
          </span>
        )}
        {entry.pnl != null && (
          <span className={cn("text-[11px] font-mono shrink-0", entry.pnl >= 0 ? "text-success" : "text-destructive")}>
            {entry.pnl >= 0 ? "+" : ""}{entry.pnl.toFixed(2)}
          </span>
        )}
        <span className="text-[11px] font-mono text-muted-foreground shrink-0 hidden sm:inline">
          {when.toLocaleDateString([], { month: "short", day: "numeric" })}
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <CardContent className="border-t border-border pt-4 pb-4 space-y-4">
          <p className="text-sm leading-relaxed">{entry.summary}</p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 font-mono text-[13px]">
            <div><div className="text-[13px] text-muted-foreground">Entry</div>{entry.entryPrice.toPrecision(6)}</div>
            {entry.exitPrice != null && (
              <div><div className="text-[13px] text-muted-foreground">Exit</div>{entry.exitPrice.toPrecision(6)}</div>
            )}
            {entry.holdingSeconds != null && (
              <div><div className="text-[13px] text-muted-foreground">Held</div>{Math.round(entry.holdingSeconds / 60)}min</div>
            )}
            {entry.exitReason && (
              <div><div className="text-[13px] text-muted-foreground">Exit reason</div>{entry.exitReason}</div>
            )}
          </div>

          {entry.findings.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground mb-1.5">
                <ListChecks className="h-3.5 w-3.5" /> Findings
              </div>
              <ul className="space-y-1">
                {entry.findings.map((f, i) => (
                  <li key={i} className="text-[13px] leading-relaxed pl-3 border-l border-border">{f}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[11px] font-mono text-muted-foreground">From trade #{entry.tradeId}</p>
        </CardContent>
      )}
    </Card>
  );
}

export function Journal() {
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [extra, setExtra] = useState<JournalEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const params = outcome === "all" ? {} : { outcome: outcome as Exclude<Outcome, "all"> };
  const { data: firstPage, isLoading, isError } = useGetJournal(params, {
    query: { refetchInterval: 30000, queryKey: getGetJournalQueryKey(params) },
  });

  const entries = [...(firstPage ?? []), ...extra];
  const lastId = entries.length ? entries[entries.length - 1]!.id : undefined;

  async function loadMore() {
    if (!lastId) return;
    setLoadingMore(true);
    try {
      const older = await getJournal({ ...params, before: lastId });
      if (!older || older.length === 0) setExhausted(true);
      else setExtra((prev) => [...prev, ...older]);
    } finally {
      setLoadingMore(false);
    }
  }

  const [exporting, setExporting] = useState(false);

  async function downloadCsv() {
    setExporting(true);
    try {
      const all: JournalEntry[] = [];
      let cursor: number | undefined;
      for (let page = 0; page < 10; page++) {
        const batch = await getJournal({ ...params, limit: 200, ...(cursor && { before: cursor }) });
        if (!batch || batch.length === 0) break;
        all.push(...batch);
        cursor = batch[batch.length - 1]!.id;
        if (batch.length < 200) break;
      }
      if (all.length === 0) return;

      const esc = (v: unknown) => {
        if (v == null) return "";
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const cols = [
        "id", "tradeId", "symbol", "side", "strategyId", "strategyName", "outcome",
        "grade", "rMultiple", "pnl", "entryTime", "exitTime", "exitReason", "summary",
      ];
      const rows = all.map((e) => [
        e.id, e.tradeId, e.symbol, e.side, e.strategyId ?? "", e.strategyName ?? "", e.outcome,
        e.grade ?? "", e.rMultiple ?? "", e.pnl ?? "", e.entryTime, e.exitTime ?? "", e.exitReason ?? "", e.summary,
      ].map(esc).join(","));
      const blob = new Blob([[cols.join(","), ...rows].join("\n")], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `tradecore-journal-${outcome}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader
        icon={BookOpen}
        title="Journal"
        description="An objective post-mortem for every closed trade — what actually happened, computed from the recorded facts. A scorecard, not a prediction."
        actions={
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={downloadCsv}
            disabled={exporting || entries.length === 0}
            title="Export the journal (current filter) as CSV — up to 2000 most recent entries"
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Export CSV
          </Button>
        }
      />

      <PageTabs tabs={PORTFOLIO_TABS} />

      <div className="-mx-1 flex flex-wrap items-center gap-1 px-1">
        {(["all", "win", "loss", "breakeven"] as Outcome[]).map((o) => (
          <Button
            key={o}
            size="sm"
            variant={outcome === o ? "secondary" : "ghost"}
            onClick={() => { setOutcome(o); setExtra([]); setExhausted(false); }}
          >
            {o === "all" ? "All" : OUTCOME_META[o as Exclude<Outcome, "all">].label}
          </Button>
        ))}
      </div>

      {isLoading && <Card><CardContent className="p-0"><LoadingRows rows={5} /></CardContent></Card>}
      {isError && (
        <Card><CardContent className="p-0">
          <EmptyState
            icon={BookOpen}
            title="Couldn't load the journal"
            description="The API didn't respond. Your entries are safe — this is a read failure."
            action={{ label: "Try again", onClick: () => window.location.reload() }}
          />
        </CardContent></Card>
      )}
      {!isLoading && !isError && entries.length === 0 && (
        <Card><CardContent className="p-0">
          <EmptyState
            icon={BookOpen}
            title={outcome === "all" ? "No journal entries yet" : `No ${outcome} entries`}
            description={
              outcome === "all"
                ? "An entry is written automatically the moment a trade closes — with its grade, its R-multiple, and what the outcome is attributable to. Nothing to write until then."
                : "Nothing matches this filter yet."
            }
            action={outcome === "all" ? { label: "View trade log", href: "/trades" } : { label: "Show all", onClick: () => { setOutcome("all"); setExtra([]); setExhausted(false); } }}
          />
        </CardContent></Card>
      )}

      <div className="space-y-2">
        {entries.map((e) => <JournalCard key={e.id} entry={e} />)}
      </div>

      {entries.length > 0 && !exhausted && (
        <div className="flex justify-center pb-6">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load older entries"}
          </Button>
        </div>
      )}
    </div>
  );
}

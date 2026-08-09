import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCopilotInbox, getGetCopilotInboxQueryKey,
  useExecuteRecommendation, useRejectRecommendation, useModifyRecommendation,
  type Recommendation, type RevalidationCheck,
} from "@workspace/api-client-react";
import { Card, CardContent, Button, Badge, Input, Label } from "@/components/ui";
import { useToast } from "@/components/ui/use-toast";
import { PageHeader, EmptyState, LoadingRows } from "@/components/patterns";
import { cn } from "@/lib/utils";
import {
  ArrowUpRight, ArrowDownRight, CheckCircle2, XCircle, Ban, Clock,
  Loader2, Inbox, Pencil, ShieldAlert, ChevronDown, ChevronUp, Maximize2,
} from "lucide-react";

/**
 * Co-Pilot inbox — TradePlans the engine produced and handed to you instead of
 * executing.
 *
 * Every plan here is byte-identical to what AutoPilot would have traded for
 * the same scan (the fingerprint proves it), so reviewing one is reviewing the
 * real decision, not a preview of it.
 *
 * Two behaviours in this page are load-bearing rather than cosmetic:
 *
 *   • Approving re-validates server-side. The button does not place an order;
 *     it re-asks the risk engine. When the answer has changed, the refusal is
 *     shown WITH every check that ran, because "no" without a reason is
 *     indistinguishable from a bug.
 *   • Modifying never edits a plan. It creates a new one you authored, linked
 *     to the original — which is what lets a later post-mortem say whether a
 *     loss was the engine's decision or yours.
 */

const STATUS_META: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  created:    { label: "Awaiting you", className: "bg-primary/10 text-primary border-primary/40", icon: Clock },
  executed:   { label: "Executed",     className: "bg-success/15 text-success border-success/40", icon: CheckCircle2 },
  rejected:   { label: "Declined",     className: "bg-muted text-muted-foreground border-border", icon: XCircle },
  expired:    { label: "Expired",      className: "bg-muted text-muted-foreground border-border", icon: Clock },
  superseded: { label: "Superseded",   className: "bg-muted text-muted-foreground border-border", icon: Pencil },
  blocked:    { label: "Blocked",      className: "bg-destructive/10 text-destructive border-destructive/40", icon: Ban },
};

const FILTERS = [
  { key: "created", label: "Awaiting you" },
  { key: "executing,executed,rejected,expired,superseded,blocked", label: "History" },
] as const;

function timeLeft(expiresAt: string): { text: string; urgent: boolean; gone: boolean } {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return { text: "expired", urgent: false, gone: true };
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return {
    text: mins > 0 ? `${mins}m ${secs}s left` : `${secs}s left`,
    urgent: ms < 120_000,
    gone: false,
  };
}

function CheckList({ checks }: { checks: RevalidationCheck[] }) {
  return (
    <div className="mt-3 space-y-1 border-t border-border pt-3">
      <p className="text-[13px] font-mono text-muted-foreground mb-2">Re-validation at approval time:</p>
      {checks.map((c) => (
        <div key={c.name} className="flex items-start gap-2 text-[13px] font-mono">
          {c.passed
            ? <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
            : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />}
          <span className={cn("shrink-0", c.passed ? "text-muted-foreground" : "text-destructive font-bold")}>
            {c.name}
          </span>
          <span className="text-muted-foreground">— {c.detail}</span>
        </div>
      ))}
    </div>
  );
}

function RecommendationCard({ rec }: { rec: Recommendation }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [checks, setChecks] = useState<RevalidationCheck[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [sl, setSl] = useState(String(rec.slPrice));
  const [tp, setTp] = useState(String(rec.tpPrice));
  const [qty, setQty] = useState(String(rec.qty));

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetCopilotInboxQueryKey() });
  const execute = useExecuteRecommendation();
  const reject = useRejectRecommendation();
  const modify = useModifyRecommendation();
  const busy = execute.isPending || reject.isPending || modify.isPending;

  const isLong = rec.side === "long";
  const meta = STATUS_META[rec.status] ?? STATUS_META["created"]!;
  const StatusIcon = meta.icon;
  const remaining = timeLeft(rec.expiresAt);
  // Only a live, unexpired plan can be acted on. A blocked plan is terminal:
  // the situation that made it sensible has passed, so there is no path from
  // here to a position and the page must not pretend otherwise.
  const actionable = rec.status === "created" && !remaining.gone;

  const onExecute = () => execute.mutate({ id: rec.id }, {
    onSuccess: (data) => {
      setChecks(data.checks ?? null);
      invalidate();
      toast({
        title: data.ok ? "Executed" : "Not executed",
        description: data.reason,
        ...(data.ok ? {} : { variant: "destructive" as const }),
      });
    },
    onError: () => toast({ title: "Error", description: "Could not reach the server.", variant: "destructive" }),
  });

  const onReject = () => reject.mutate({ id: rec.id, data: {} }, {
    onSuccess: (data) => { invalidate(); toast({ title: "Declined", description: data.reason }); },
  });

  const onModify = () => modify.mutate(
    { id: rec.id, data: { slPrice: Number(sl), tpPrice: Number(tp), qty: Number(qty) } },
    {
      onSuccess: (data) => {
        invalidate();
        setEditing(false);
        toast({
          title: data.ok ? "Your plan created" : "Could not modify",
          description: data.reason,
          ...(data.ok ? {} : { variant: "destructive" as const }),
        });
      },
    },
  );

  return (
    <Card className={cn("border", !actionable && rec.status !== "created" && "opacity-80")}>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Badge variant="outline" className={cn("font-mono text-[13px]", isLong
            ? "bg-success/15 text-success border-success/40"
            : "bg-destructive/10 text-destructive border-destructive/40")}>
            {isLong ? <ArrowUpRight className="h-3 w-3 mr-1" /> : <ArrowDownRight className="h-3 w-3 mr-1" />}
            {rec.side.toUpperCase()}
          </Badge>
          <span className="font-mono font-bold">{rec.symbol}</span>
          <Badge variant="outline" className={cn("font-mono text-[13px]", meta.className)}>
            <StatusIcon className="h-3 w-3 mr-1" />{meta.label}
          </Badge>
          {rec.authoredBy === "user" && (
            <Badge variant="outline" className="font-mono text-[13px] bg-warning/10 text-warning border-warning/40">
              <Pencil className="h-3 w-3 mr-1" />Your plan
              {rec.derivedFromId != null && <span className="ml-1 opacity-70">from #{rec.derivedFromId}</span>}
            </Badge>
          )}
          <span className="ml-auto font-mono text-[13px] text-muted-foreground">
            {rec.strategyName ?? rec.strategyId} · {rec.confidence.toFixed(0)}%
          </span>
          <Link href={`/copilot/${rec.id}`}>
            <Button size="sm" variant="ghost" className="px-2 text-[13px]">
              <Maximize2 className="h-3 w-3 mr-1" />Workspace
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-sm">
          <div><p className="text-[13px] text-muted-foreground">Entry</p><p className="font-bold">{rec.entryPrice}</p></div>
          <div><p className="text-[13px] text-muted-foreground">Stop</p><p className="font-bold text-destructive">{rec.slPrice}</p></div>
          <div><p className="text-[13px] text-muted-foreground">Target</p><p className="font-bold text-success">{rec.tpPrice}</p></div>
          <div><p className="text-[13px] text-muted-foreground">Size</p><p className="font-bold">{rec.qty}{rec.leverage > 1 && ` · ${rec.leverage}x`}</p></div>
        </div>

        {rec.entryReason && (
          <p className="mt-3 text-sm text-muted-foreground">{rec.entryReason}</p>
        )}

        {rec.status === "created" && (
          <p className={cn("mt-3 text-[13px] font-mono", remaining.urgent ? "text-warning font-bold" : "text-muted-foreground")}>
            <Clock className="h-3 w-3 inline mr-1" />
            {remaining.gone ? "This plan has expired — the setup it described is no longer current." : remaining.text}
          </p>
        )}

        {rec.resolutionReason && rec.status !== "created" && (
          <p className={cn("mt-3 text-[13px] font-mono flex items-start gap-1.5",
            rec.status === "blocked" ? "text-destructive" : "text-muted-foreground")}>
            {rec.status === "blocked" && <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
            {rec.resolutionReason}
          </p>
        )}

        {checks && <CheckList checks={checks} />}

        {editing && (
          <div className="mt-4 border-t border-border pt-4 space-y-3">
            <p className="text-[13px] font-mono text-muted-foreground">
              This creates a NEW plan authored by you. The engine's original is kept
              unchanged, so a later post-mortem can tell the two apart.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><Label className="text-[13px]">Stop</Label><Input value={sl} onChange={(e) => setSl(e.target.value)} className="font-mono" /></div>
              <div><Label className="text-[13px]">Target</Label><Input value={tp} onChange={(e) => setTp(e.target.value)} className="font-mono" /></div>
              <div><Label className="text-[13px]">Size</Label><Input value={qty} onChange={(e) => setQty(e.target.value)} className="font-mono" /></div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={onModify} disabled={busy}>
                {modify.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Create my plan
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        )}

        {actionable && !editing && (
          <div className="flex flex-wrap gap-2 mt-4">
            <Button size="sm" onClick={onExecute} disabled={busy}>
              {execute.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Execute
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy}>
              <Pencil className="h-3 w-3 mr-1" />Modify
            </Button>
            <Button size="sm" variant="ghost" onClick={onReject} disabled={busy}>
              {reject.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Decline
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function CoPilot() {
  const [filter, setFilter] = useState<string>(FILTERS[0].key);
  const [showHelp, setShowHelp] = useState(false);
  // Recommendations expire on their own clock, so poll rather than waiting for
  // a user action to reveal that the inbox has gone stale.
  const { data, isLoading } = useGetCopilotInbox({ status: filter }, {
    query: { queryKey: getGetCopilotInboxQueryKey({ status: filter }), refetchInterval: 15_000 },
  });
  const recommendations = data?.recommendations ?? [];

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div>
        <PageHeader icon={Inbox} title="AI Co-Pilot" />
        <button
          onClick={() => setShowHelp((v) => !v)}
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mt-1"
        >
          Plans the engine produced for you to decide on
          {showHelp ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
        {showHelp && (
          <div className="mt-3 text-sm text-muted-foreground space-y-2 max-w-3xl">
            <p>
              Each plan below is exactly what AutoPilot would have traded for the same scan —
              same strategy, same numbers, same reasoning. Co-Pilot changes who presses the button,
              not what the engine decides.
            </p>
            <p>
              Approving re-runs every risk check at that moment. If something has changed —
              the price has moved away from the plan, another position has opened, the daily loss
              limit has been hit — the trade is refused and you are told exactly which check failed.
            </p>
            <p>
              Modifying a plan creates a new one authored by you, linked to the engine's original.
              Nothing is overwritten, so the record always shows whose decision a result came from.
            </p>
          </div>
        )}
      </div>

      <div className="-mx-1 flex gap-1 px-1">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? "secondary" : "ghost"}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <Card><CardContent className="p-0"><LoadingRows rows={3} /></CardContent></Card>
      ) : recommendations.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            {filter === "created" ? (
              <EmptyState
                icon={Inbox}
                title="Nothing waiting on you"
                description="The engine scans continuously and will put a plan here the moment one of your strategies finds a setup worth taking. It never opens a position on its own in Co-Pilot."
                action={{ label: "Check the engine is running", href: "/" }}
              />
            ) : (
              <EmptyState
                icon={Inbox}
                title="No past recommendations yet"
                description="Plans you execute, modify or decline are kept here so a result can always be traced back to whose decision it was."
              />
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {recommendations.map((rec) => <RecommendationCard key={rec.id} rec={rec} />)}
        </div>
      )}
    </div>
  );
}

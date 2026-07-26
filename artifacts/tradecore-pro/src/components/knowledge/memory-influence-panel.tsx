import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMemoryInfluence, getGetMemoryInfluenceQueryKey,
  useUpdateMemoryInfluence, useRunMemoryValidation,
} from "@workspace/api-client-react";
import {
  Card, CardHeader, CardTitle, CardContent, Button, Badge, Switch, Label,
  Table, TableHeader, TableRow, TableHead, TableBody, TableCell,
} from "@/components/ui";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { BrainCog, ShieldCheck, ShieldAlert, Loader2, FlaskConical, Power } from "lucide-react";

/**
 * Gated Memory Influence — the one control in this product that lets the
 * account's own history change what the engine does next.
 *
 * The UI's job here is mostly to prevent a specific misunderstanding: that
 * turning the switch on turns the behaviour on. It does not. Enabled is a
 * request; ACTIVE is the conjunction of the request, qualifying evidence, and
 * — on live — a walk-forward validation that approved this exact rule set. So
 * the two are shown as separate facts with the gap explained in prose,
 * rather than as one green toggle that implies more than it delivers.
 *
 * The other job is to keep the direction honest. Memory can only ever
 * withhold a trade; it never takes one the strategies did not ask for. That
 * sentence is on the panel, not just in the docs, because it is the whole
 * reason this is a safe thing to switch on.
 */

const VERDICT_META: Record<string, { label: string; className: string }> = {
  improved:          { label: "Improved",           className: "border-success/40 text-success" },
  no_better:         { label: "No better",          className: "border-warning/40 text-warning" },
  insufficient_data: { label: "Insufficient data",  className: "border-border text-muted-foreground" },
};

export function MemoryInfluencePanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [validating, setValidating] = useState(false);

  const { data, isLoading } = useGetMemoryInfluence({
    query: { queryKey: getGetMemoryInfluenceQueryKey() },
  });
  const update = useUpdateMemoryInfluence();
  const validate = useRunMemoryValidation();

  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetMemoryInfluenceQueryKey() });

  async function onToggle(enabled: boolean) {
    const res = await update.mutateAsync({ data: { enabled } });
    await refresh();
    toast({
      title: enabled ? "Memory influence requested" : "Memory influence off",
      description: res.reason,
    });
  }

  async function onValidate() {
    setValidating(true);
    try {
      const res = await validate.mutateAsync();
      await refresh();
      toast({
        title: `Validation: ${VERDICT_META[res.verdict]?.label ?? res.verdict}`,
        description: res.summary,
        variant: res.verdict === "improved" ? undefined : "destructive",
      });
    } finally {
      setValidating(false);
    }
  }

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
            <BrainCog className="h-4 w-4" /> Gated Memory Influence
          </CardTitle>
        </CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Reading memory state…</p></CardContent>
      </Card>
    );
  }

  const v = data.latestValidation;
  const verdictMeta = v?.verdict ? VERDICT_META[v.verdict] : undefined;

  return (
    <Card className={cn("relative overflow-hidden", data.active && "border-primary/40")}>
      <div className="absolute top-0 right-0 p-32 bg-primary/5 blur-3xl rounded-full pointer-events-none" />

      <CardHeader>
        <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
          <BrainCog className="h-4 w-4 text-primary" /> Gated Memory Influence
          <Badge
            variant="outline"
            className={cn(
              "ml-auto text-[10px] font-mono uppercase",
              data.active ? "border-primary/40 text-primary" : "border-border text-muted-foreground",
            )}
          >
            {data.active ? "active" : "inactive"}
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Lets your own closed trades raise the confidence bar on new plans.
          It can only ever <span className="text-foreground font-medium">withhold</span> a trade —
          it never takes one your strategies did not ask for.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* The switch is a REQUEST. Active is a separate fact, stated below it. */}
        <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
          <div className="space-y-1">
            <Label htmlFor="memory-influence" className="text-sm font-medium">
              Let memory raise the bar
            </Label>
            <p className="text-xs text-muted-foreground max-w-xl">{data.reason}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {data.enabled && !data.active && (
              <ShieldAlert className="h-4 w-4 text-warning" aria-label="requested but not active" />
            )}
            {data.active && <ShieldCheck className="h-4 w-4 text-success" aria-label="active" />}
            <Switch
              id="memory-influence"
              checked={data.enabled}
              disabled={update.isPending}
              onCheckedChange={onToggle}
            />
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{data.summary}</p>

        {/* Walk-forward validation — the only thing that unlocks live. */}
        <div className="rounded border border-border p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
              <FlaskConical className="h-3.5 w-3.5" /> Walk-forward validation
              {verdictMeta && (
                <Badge variant="outline" className={cn("text-[10px] font-mono uppercase", verdictMeta.className)}>
                  {verdictMeta.label}
                </Badge>
              )}
            </div>
            <Button size="sm" variant="outline" onClick={onValidate} disabled={validating}>
              {validating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Run"}
            </Button>
          </div>

          {v?.summary ? (
            <p className="text-xs text-muted-foreground">{v.summary}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Not run yet. Cells are fitted on an earlier window and tested on a later one they
              never saw — the only evidence that unlocks influence on a live account.
            </p>
          )}

          {v && v.validationTrades > 0 && (
            <div className="grid grid-cols-3 gap-3 font-mono text-xs pt-1">
              <div>
                <p className="text-muted-foreground">Out-of-sample</p>
                <p className="font-bold">{v.validationTrades} trades</p>
              </div>
              <div>
                <p className="text-muted-foreground">Would withhold</p>
                <p className="font-bold">
                  {v.withheld}
                  {v.withheldPnlUsdt != null && (
                    <span className={cn("ml-1 font-normal", v.withheldPnlUsdt < 0 ? "text-success" : "text-destructive")}>
                      (${v.withheldPnlUsdt.toFixed(2)})
                    </span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Expectancy Δ</p>
                <p className={cn("font-bold", (v.expectancyDelta ?? 0) > 0 ? "text-success" : "text-muted-foreground")}>
                  {v.expectancyDelta != null ? `${v.expectancyDelta > 0 ? "+" : ""}$${v.expectancyDelta.toFixed(2)}` : "—"}
                </p>
              </div>
            </div>
          )}

          {data.needsValidation && (
            <p className="text-xs text-warning">
              Live influence stays paused until a run returns “improved” for the current rule set
              ({data.version}). Demo needs no approval — that is where a rule set is meant to be tried first.
            </p>
          )}
        </div>

        {/* The rules themselves. */}
        {data.rules.length > 0 && (
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
              Acting rules · cap +{data.maxDelta} points · {data.version}
            </p>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Cell</TableHead>
                  <TableHead className="text-right">Trades</TableHead>
                  <TableHead className="text-right">Win Rate</TableHead>
                  <TableHead className="text-right">q</TableHead>
                  <TableHead className="text-right">Bar</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rules.map((r) => (
                  <TableRow key={`${r.dimension}:${r.key}`}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="font-mono text-right">{r.samples}</TableCell>
                    <TableCell className="font-mono text-right">
                      {(r.winRate * 100).toFixed(0)}%
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        vs {(r.baselineWinRate * 100).toFixed(0)}%
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-right text-xs text-muted-foreground">
                      {r.qValue.toFixed(3)}
                    </TableCell>
                    <TableCell className="font-mono text-right font-bold text-warning">+{r.delta}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* The audit trail. Both outcomes, so this is not a list of saves. */}
        {data.recent.length > 0 && (
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
              Applied · last {data.recent.length}
            </p>
            <div className="space-y-0.5 max-h-56 overflow-y-auto">
              {data.recent.map((r) => (
                <div key={r.id} className="flex items-center gap-3 text-xs font-mono">
                  <span className={cn("w-16 shrink-0", r.admitted ? "text-muted-foreground" : "text-warning")}>
                    {r.admitted ? "passed" : "withheld"}
                  </span>
                  <span className="w-24 shrink-0 truncate">{r.symbol}</span>
                  <span className="w-14 shrink-0 text-right">
                    {r.confidence.toFixed(0)}/{r.requiredConfidence.toFixed(0)}
                  </span>
                  <span className="flex-1 truncate text-muted-foreground">{r.strategyId}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.enabled && (
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant="destructive" onClick={() => onToggle(false)} disabled={update.isPending}>
              <Power className="h-3.5 w-3.5 mr-1.5" /> Turn off now
            </Button>
            <p className="text-xs text-muted-foreground">
              Takes effect on the next scan — no restart, and nothing in flight keeps acting on it.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

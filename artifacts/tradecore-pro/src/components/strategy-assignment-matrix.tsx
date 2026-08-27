import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useSection } from "@/lib/section";
import { traderApi, type StrategyAssignment, type StrategyCatalogItem } from "@/lib/cactus-api";

export function StrategyAssignmentMatrix() {
  const { section } = useSection();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["strategy-catalog", section], queryFn: () => traderApi<StrategyCatalogItem[]>("/strategies") });
  const mutation = useMutation({
    mutationFn: ({ item, mode, enabled }: { item: StrategyCatalogItem; mode: "brain" | "copilot" | "autopilot"; enabled: boolean }) => {
      const next: StrategyAssignment = { ...item.assignment, [mode]: enabled };
      return traderApi(`/strategies/assignments/${encodeURIComponent(item.strategyId)}`, {
        method: "PUT",
        body: JSON.stringify({ expectedRevision: item.assignment.revision, brain: next.brain, copilot: next.copilot, autopilot: next.autopilot }),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["strategy-catalog", section] }),
  });
  if (query.isLoading) return <div className="grid min-h-64 place-items-center text-sm text-muted-foreground" role="status"><span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading assignment matrix</span></div>;
  if (query.isError) return <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" role="alert">Assignments could not be read. No strategy state has been changed.</div>;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-live/30 bg-live/10 p-4 text-sm">
        <div className="flex items-center gap-2 font-semibold text-live"><ShieldCheck className="h-4 w-4" /> AutoPilot assignments are desired-next configuration</div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">They never rewrite the immutable strategy set of an active mandate. A replacement mandate must pass the existing authorization workflow.</p>
      </div>
      {mutation.error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert"><AlertTriangle className="mr-2 inline h-4 w-4" />{mutation.error.message} Refresh after a revision conflict.</div>}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="sticky top-0 bg-surface text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><tr><th className="px-4 py-3">Strategy</th><th>Version</th><th>Market</th><th>Master</th><th className="text-center">Brain</th><th className="text-center">Co-Pilot</th><th className="pr-4 text-center">AutoPilot next</th></tr></thead>
          <tbody className="divide-y">
            {(query.data ?? []).map((item) => {
              const customBlocked = item.kind === "custom" && item.backtested === false;
              const pending = mutation.isPending && mutation.variables?.item.strategyId === item.strategyId;
              return <tr key={item.strategyId}><td className="px-4 py-4"><strong className="block">{item.strategyName}</strong><span className="mt-1 block font-mono text-[10px] text-muted-foreground">{item.fingerprint.slice(0, 16)}…</span></td><td className="font-mono text-xs">{item.version}</td><td className="capitalize">{item.supportedMarket}</td><td><Badge variant={item.config.enabled ? "success" : "outline"}>{item.config.enabled ? "Active" : "Inactive"}</Badge></td>{(["brain", "copilot", "autopilot"] as const).map((mode) => <td key={mode} className="text-center"><Switch aria-label={`${item.strategyName} for ${mode}`} checked={item.assignment[mode]} disabled={pending || (mode === "autopilot" && customBlocked)} onCheckedChange={(enabled) => mutation.mutate({ item, mode, enabled })} /></td>)}</tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

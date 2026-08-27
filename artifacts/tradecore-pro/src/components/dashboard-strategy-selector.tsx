import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers3, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useSection } from "@/lib/section";
import {
  traderApi,
  type StrategyAssignment,
  type StrategyCatalogItem,
} from "@/lib/cactus-api";
import { cn } from "@/lib/utils";

const modeLabels = {
  brain: "Brain",
  copilot: "Co-Pilot",
  autopilot: "AutoPilot",
} as const;

export function DashboardStrategySelector({
  authorizedAutopilotStrategies,
}: {
  authorizedAutopilotStrategies: string[];
}) {
  const { section } = useSection();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const catalogQuery = useQuery({
    queryKey: ["strategy-catalog", section],
    queryFn: () => traderApi<StrategyCatalogItem[]>("/strategies"),
    enabled: open,
  });
  const mutation = useMutation({
    mutationFn: ({ item, mode, enabled }: {
      item: StrategyCatalogItem;
      mode: keyof typeof modeLabels;
      enabled: boolean;
    }) => {
      const next: StrategyAssignment = { ...item.assignment, [mode]: enabled };
      return traderApi<{ assignment: StrategyAssignment }>(
        `/strategies/assignments/${encodeURIComponent(item.strategyId)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            expectedRevision: item.assignment.revision,
            brain: next.brain,
            copilot: next.copilot,
            autopilot: next.autopilot,
          }),
        },
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["strategy-catalog", section] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard-session", section] });
    },
  });

  const items = catalogQuery.data ?? [];
  const activeCount = items.filter((item) => item.config.enabled).length;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="min-h-10 gap-2">
          <Layers3 className="h-4 w-4" /> Strategies
          {open || catalogQuery.data ? <span className="font-mono text-xs">{activeCount} active</span> : null}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 pb-5 pt-6 text-left">
          <SheetTitle>Session strategy set</SheetTitle>
          <SheetDescription>
            Choose the strategies available to each intelligence mode. Master configuration and evidence remain in Strategies.
          </SheetDescription>
        </SheetHeader>

        <div className="border-b bg-muted/20 px-5 py-4 text-xs leading-5 text-muted-foreground">
          <div className="flex gap-2 text-foreground">
            <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-live" />
            <strong>AutoPilot authority is immutable.</strong>
          </div>
          <p className="mt-1 pl-6">
            AutoPilot toggles below are the desired next set. They do not add a strategy to an active mandate. Review and approve a replacement mandate in the authority workflow.
          </p>
        </div>

        {mutation.error && (
          <div className="m-5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            {mutation.error.message} Refresh the strategy list before retrying if another tab changed it.
          </div>
        )}

        {catalogQuery.isLoading ? (
          <div className="grid min-h-64 place-items-center text-sm text-muted-foreground" role="status">
            <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading strategy assignments</span>
          </div>
        ) : catalogQuery.isError ? (
          <div className="m-5 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
            Strategy assignments are unavailable. No assignment has been changed.
          </div>
        ) : (
          <div className="divide-y">
            {items.map((item) => {
              const customBlocked = item.kind === "custom" && item.backtested === false;
              return (
                <article key={item.strategyId} className="space-y-4 px-5 py-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold">{item.strategyName}</h3>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        {item.version} · {item.fingerprint.slice(0, 12)}…
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-wide">
                        <span className="rounded border px-1.5 py-0.5">{item.kind}</span>
                        <span className="rounded border px-1.5 py-0.5">{item.supportedMarket}</span>
                        <span className={cn("rounded border px-1.5 py-0.5", item.config.enabled ? "border-positive/30 text-positive" : "text-muted-foreground")}>
                          {item.config.enabled ? "Master active" : "Master inactive"}
                        </span>
                      </div>
                    </div>
                    {authorizedAutopilotStrategies.includes(item.strategyId) && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded border border-live/30 bg-live/10 px-2 py-1 text-[10px] font-semibold text-live">
                        <ShieldCheck className="h-3 w-3" /> Authorized now
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {(Object.keys(modeLabels) as Array<keyof typeof modeLabels>).map((mode) => {
                      const blocked = mode === "autopilot" && customBlocked;
                      const pending = mutation.isPending && mutation.variables?.item.strategyId === item.strategyId;
                      return (
                        <label
                          key={mode}
                          className={cn(
                            "flex min-h-16 flex-col justify-between rounded-lg border p-2 text-xs",
                            blocked && "bg-muted/30 text-muted-foreground",
                          )}
                        >
                          <span>{modeLabels[mode]}</span>
                          <Switch
                            aria-label={`${item.strategyName} for ${modeLabels[mode]}`}
                            checked={item.assignment[mode]}
                            disabled={pending || blocked}
                            onCheckedChange={(enabled) => mutation.mutate({ item, mode, enabled })}
                          />
                        </label>
                      );
                    })}
                  </div>
                  {customBlocked && (
                    <p className="text-xs text-warning">AutoPilot assignment requires this custom strategy to pass its existing backtest gate.</p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

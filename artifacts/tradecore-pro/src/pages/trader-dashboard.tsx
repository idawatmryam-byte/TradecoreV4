import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Clock3,
  ExternalLink,
  Loader2,
  PauseCircle,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  WalletCards,
  XCircle,
} from "lucide-react";
import {
  activateAutopilot,
  createAutopilotMandate,
  executeRecommendation,
  getAutopilotControl,
  getConfig,
  getGetCopilotInboxQueryKey,
  getGetBotStatusQueryKey,
  getGetConfigQueryKey,
  getRecommendationWorkspace,
  getStrategies,
  pauseAutopilot,
  rejectRecommendation,
  transitionAutopilotBrainVersion,
  updateConfig,
  useGetConfig,
  useStartBot,
  useStopBot,
  type ExecuteRecommendationBody,
  type RecommendationWorkspace,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarketChart } from "@/components/market-chart";
import { CopilotApprovalDialog } from "@/components/copilot-approval-dialog";
import { DashboardTradeSetup } from "@/components/dashboard-trade-setup";
import { DashboardStrategySelector } from "@/components/dashboard-strategy-selector";
import { MarketOverview } from "@/components/market-overview";
import { useSection } from "@/lib/section";
import {
  traderApi,
  type DashboardPosition,
  type DashboardRecommendation,
  type DashboardSession,
  type MetricValue,
  type TraderCapabilities,
} from "@/lib/cactus-api";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";

function money(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatMetric(metric: MetricValue): string {
  if (metric.state === "unavailable" || metric.value === null) return "Unavailable";
  if (metric.unit === "currency") return money(metric.value);
  if (metric.unit === "percent") return `${metric.value.toFixed(2)}%`;
  return metric.value.toLocaleString();
}

function MetricTile({ label, metric }: { label: string; metric: MetricValue }) {
  const unavailable = metric.state === "unavailable" || metric.value === null;
  return (
    <div className="min-w-0 border-r px-3 py-3 last:border-r-0 sm:px-4" title={metric.reason ?? metric.source ?? undefined}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
        {metric.state === "stale" && <AlertTriangle className="h-3 w-3 text-warning" aria-label="Stale" />}
      </div>
      <div className={cn("mt-1.5 truncate font-mono text-sm font-semibold sm:text-base", unavailable && "text-muted-foreground")}>
        {formatMetric(metric)}
      </div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground">
        {unavailable ? metric.reason : metric.source}
      </div>
    </div>
  );
}

function StatusDot({ state }: { state: string }) {
  return (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        state === "available" ? "bg-positive" : state === "partial" || state === "stale" ? "bg-warning" : "bg-destructive",
      )}
      aria-hidden="true"
    />
  );
}

function ModeControl({ session }: { session: DashboardSession }) {
  const queryClient = useQueryClient();
  const { section } = useSection();
  const { toast } = useToast();
  const [autopilotReview, setAutopilotReview] = useState(false);
  const mutation = useMutation({
    mutationFn: (mode: "research" | "copilot") =>
      traderApi("/config", { method: "PUT", body: JSON.stringify({ mode }) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard-session", section] });
      await queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
    },
  });
  const enableAutopilot = useMutation({
    mutationFn: async () => {
      await updateConfig({ mode: "autopilot" });
      const [config, strategies, controlCenter] = await Promise.all([
        getConfig(),
        getStrategies(),
        getAutopilotControl(),
      ]);
      if (controlCenter.globalSuspended) {
        throw new Error(
          "AutoPilot is paused for the whole platform. Your shared setup is saved, but an administrator must clear the platform pause before activation.",
        );
      }
      let approvedBrain = controlCenter.versions.find((version) => version.state === "DEMO_APPROVED");
      if (!approvedBrain) {
        const controlBrain = controlCenter.versions.find(
          (version) => version.implementation === "brain-v0-control" && version.state === "COPILOT",
        );
        if (!controlBrain) {
          throw new Error(
            "No eligible AutoPilot release is available. A retired release cannot be restored; an administrator must publish a replacement.",
          );
        }
        approvedBrain = await transitionAutopilotBrainVersion(controlBrain.id, {
          toState: "DEMO_APPROVED",
          reason: "Trader approved the exact Demo AutoPilot release with the current shared setup",
          confirmation: "APPROVE_BRAIN_VERSION_FOR_DEMO",
        });
      }
      const enabledStrategies = strategies.filter(
        (strategy) => strategy.config.enabled && strategy.assignment.autopilot,
      );
      if (enabledStrategies.length === 0) {
        throw new Error("Select at least one active AutoPilot strategy before enabling AutoPilot.");
      }
      if (config.dailyLossLimitUsdt <= 0) {
        throw new Error("Set a positive daily loss limit before enabling AutoPilot.");
      }
      const maximumLeverage = config.marketType === "futures" ? config.leverage : 1;
      const mandate = await createAutopilotMandate({
        brainVersionId: approvedBrain.id,
        instruments: config.pairs,
        strategyIds: enabledStrategies.map((strategy) => strategy.strategyId),
        maximumPositionSizeUsdt: config.positionSizeUsdt * maximumLeverage,
        maximumLeverage,
        maximumPortfolioRiskPercent: config.maxPortfolioRiskPercent,
        maximumSymbolExposurePercent: config.maxSymbolConcentrationPercent,
        maximumNetExposurePercent: config.maxNetExposurePercent,
        maximumCorrelatedExposurePercent: config.maxCorrelatedExposurePercent,
        dailyLossLimitUsdt: config.dailyLossLimitUsdt,
        maximumDrawdownPercent: 10,
        maximumConcurrentPositions: config.maxOpenPositions,
        maximumMarketDataAgeSeconds: Math.min(300, Math.max(30, config.scanIntervalSeconds * 3)),
        allowedTradingHoursUtc: [],
        permittedPhase7Actions: ["HOLD", "FREEZE", "REDUCE", "TIGHTEN_STOP", "APPLY_TRAILING", "EXIT"],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
        confirmation: "CREATE_IMMUTABLE_DEMO_MANDATE",
      });
      return activateAutopilot({
        mandateId: mandate.id,
        reason: "Trader enabled Demo AutoPilot from the Dashboard using the reviewed shared setup",
        confirmation: "ENABLE_DEMO_AUTOPILOT",
      });
    },
    onSuccess: async () => {
      setAutopilotReview(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard-session", section] }),
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() }),
      ]);
      toast({
        title: "Demo AutoPilot enabled",
        description: "AutoPilot now uses the same markets, trade limits, cadence, and selected strategies as your shared Dashboard setup.",
      });
    },
  });
  const modes = [
    { id: "brain", backend: "research" as const, label: "Brain", sub: "Analysis only" },
    { id: "copilot", backend: "copilot" as const, label: "Co-Pilot", sub: "Approval required" },
    { id: "autopilot", backend: null, label: "AutoPilot", sub: "Mandate controlled" },
  ] as const;

  return (
    <>
      <div className="grid grid-cols-3 gap-1 rounded-lg border bg-muted/20 p-1" aria-label="Trading intelligence mode">
        {modes.map((mode) => {
          const selected = session.context.mode.configured === mode.id;
          return (
            <button
              key={mode.id}
              type="button"
              aria-pressed={selected}
              disabled={mutation.isPending}
              onClick={() => {
                if (mode.id === "autopilot") setAutopilotReview(true);
                else if (!selected && mode.backend) mutation.mutate(mode.backend);
              }}
              className={cn(
                "min-h-14 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <span className="block text-xs font-semibold sm:text-sm">{mode.label}</span>
              <span className="mt-0.5 hidden text-[10px] text-muted-foreground sm:block">{mode.sub}</span>
            </button>
          );
        })}
      </div>
      {mutation.error && <p className="mt-2 text-xs text-destructive" role="alert">{mutation.error.message}</p>}

      <Dialog open={autopilotReview} onOpenChange={setAutopilotReview}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable AutoPilot with this setup</DialogTitle>
            <DialogDescription>
              AutoPilot uses the same markets, sizing, protection, confidence, cadence, and strategy selection as Co-Pilot. Review the shared setup once, then enable it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border bg-muted/20 p-4">
              <strong className="block">Current shared trade setup</strong>
              <span className="mt-1 block text-muted-foreground">Use Trade setup and Strategies on the Dashboard to change what Co-Pilot and AutoPilot use.</span>
            </div>
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-xs leading-5">
              Enabling creates a bounded 30-day Demo mandate with a 10% maximum drawdown cap. Every entry still requires fresh market data, reconciliation, deterministic risk approval, and the exact authorized strategy version. Live AutoPilot remains unavailable here.
            </div>
            {enableAutopilot.error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">{enableAutopilot.error.message}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={enableAutopilot.isPending} onClick={() => setAutopilotReview(false)}>Cancel</Button>
            <Button disabled={enableAutopilot.isPending || session.autopilot?.effectiveState === "AUTOPILOT_ENABLED"} onClick={() => enableAutopilot.mutate()}>
              {enableAutopilot.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {session.autopilot?.effectiveState === "AUTOPILOT_ENABLED" ? "AutoPilot is active" : "Enable Demo AutoPilot"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RecommendationPanel({ recommendation }: { recommendation: DashboardRecommendation | undefined }) {
  const { section } = useSection();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [liveWorkspace, setLiveWorkspace] = useState<RecommendationWorkspace | null>(null);
  const [liveIdempotencyKey, setLiveIdempotencyKey] = useState("");

  async function refreshRecommendationState() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard-session", section] }),
      queryClient.invalidateQueries({ queryKey: getGetCopilotInboxQueryKey() }),
    ]);
  }

  function approvalBody(workspace: RecommendationWorkspace, confirmation: string, password?: string): ExecuteRecommendationBody {
    if (
      !workspace.decisionBundleFingerprint ||
      !workspace.executionTarget ||
      !workspace.approvalChallenge
    ) {
      throw new Error("This recommendation no longer has complete approval evidence.");
    }
    return {
      expectedPlanFingerprint: workspace.recommendation.planFingerprint,
      expectedDecisionBundleFingerprint: workspace.decisionBundleFingerprint,
      executionTarget: workspace.executionTarget,
      approvalChallenge: workspace.approvalChallenge,
      idempotencyKey: crypto.randomUUID(),
      confirmation,
      ...(password ? { password } : {}),
    };
  }

  const approve = useMutation({
    mutationFn: async () => {
      if (!recommendation) throw new Error("Recommendation is unavailable.");
      const workspace = await getRecommendationWorkspace(recommendation.id);
      if (
        workspace.approvalState !== "APPROVABLE" ||
        !workspace.approvalReadiness.approvable
      ) {
        throw new Error(workspace.approvalReadiness.reason);
      }
      if (workspace.executionTarget === "live") {
        return { kind: "live" as const, workspace };
      }
      if (workspace.executionTarget !== "demo") {
        throw new Error("The execution target is unavailable; nothing was authorized.");
      }
      const phrase = `APPROVE ${workspace.recommendation.symbol} ${workspace.recommendation.side.toUpperCase()} FOR DEMO`;
      return {
        kind: "result" as const,
        result: await executeRecommendation(
          workspace.recommendation.id,
          approvalBody(workspace, phrase),
        ),
      };
    },
    onSuccess: async (outcome) => {
      if (outcome.kind === "live") {
        setLiveIdempotencyKey(crypto.randomUUID());
        setLiveWorkspace(outcome.workspace);
        return;
      }
      await refreshRecommendationState();
      toast({
        title: outcome.result.ok ? "Trade executed" : "Approval refused",
        description: outcome.result.reason,
        ...(outcome.result.ok ? {} : { variant: "destructive" as const }),
      });
    },
    onError: (error) =>
      toast({ title: "Approval refused", description: error.message, variant: "destructive" }),
  });
  const executeLive = useMutation({
    mutationFn: async ({ confirmation, password }: { confirmation: string; password?: string }) => {
      if (!liveWorkspace) throw new Error("Live approval evidence is unavailable.");
      const body = approvalBody(liveWorkspace, confirmation, password);
      body.idempotencyKey = liveIdempotencyKey;
      return executeRecommendation(liveWorkspace.recommendation.id, body);
    },
    onSuccess: async (result) => {
      setLiveWorkspace(null);
      await refreshRecommendationState();
      toast({
        title: result.ok ? "Trade executed" : "Approval refused",
        description: result.reason,
        ...(result.ok ? {} : { variant: "destructive" as const }),
      });
    },
    onError: (error) =>
      toast({ title: "Approval refused", description: error.message, variant: "destructive" }),
  });

  const deny = useMutation({
    mutationFn: async () => {
      if (!recommendation) throw new Error("Recommendation is unavailable.");
      const workspace = await getRecommendationWorkspace(recommendation.id);
      if (!workspace.approvalChallenge) {
        throw new Error("This recommendation is no longer awaiting a decision.");
      }
      return rejectRecommendation(recommendation.id, {
        expectedPlanFingerprint: workspace.recommendation.planFingerprint,
        approvalChallenge: workspace.approvalChallenge,
      });
    },
    onSuccess: async (result) => {
      await refreshRecommendationState();
      toast({ title: "Recommendation denied", description: result.reason });
    },
    onError: (error) =>
      toast({ title: "Deny failed", description: error.message, variant: "destructive" }),
  });

  if (!recommendation) {
    return (
      <div className="grid min-h-64 place-items-center px-6 text-center">
        <div>
          <CheckCircle2 className="mx-auto h-7 w-7 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">No recommendation awaiting approval</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">This is a confirmed empty inbox, not an execution instruction.</p>
          <Button asChild variant="outline" size="sm" className="mt-4"><Link href="/copilot">Open recommendation history</Link></Button>
        </div>
      </div>
    );
  }
  const long = recommendation.side === "long";
  const busy = approve.isPending || deny.isPending || executeLive.isPending;
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge variant={long ? "success" : "destructive"}>{long ? <ArrowUpRight className="mr-1 h-3 w-3" /> : <ArrowDownRight className="mr-1 h-3 w-3" />}{recommendation.side.toUpperCase()}</Badge>
            <span className="font-mono text-lg font-semibold">{recommendation.symbol}</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{recommendation.strategyName ?? recommendation.strategyId ?? "Strategy unavailable"}</p>
        </div>
        <div className="text-right">
          <div className="font-mono text-xl font-semibold">{Math.round(recommendation.confidence * (recommendation.confidence <= 1 ? 100 : 1))}%</div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">confidence</div>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/20 p-3 text-xs">
        <div><dt className="text-muted-foreground">Proposed entry</dt><dd className="mt-1 font-mono">{recommendation.entryPrice}</dd></div>
        <div><dt className="text-muted-foreground">Position estimate</dt><dd className="mt-1 font-mono">{recommendation.quantity}</dd></div>
        <div><dt className="text-muted-foreground">Stop loss</dt><dd className="mt-1 font-mono text-negative">{recommendation.stopLoss}</dd></div>
        <div><dt className="text-muted-foreground">Take profit</dt><dd className="mt-1 font-mono text-positive">{recommendation.takeProfit}</dd></div>
      </dl>
      <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs leading-5">
        <strong className="block">Your approval is required.</strong>
        Approval revalidates price, expiry, risk, portfolio state, and the immutable plan fingerprint on the server.
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button size="sm" disabled={busy} onClick={() => approve.mutate()}>{approve.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}{approve.isPending ? "Approving…" : "Approve"}</Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => deny.mutate()}>{deny.isPending ? "Denying…" : "Deny"}</Button>
        <Button asChild size="sm" variant="outline"><Link href={`/dashboard/recommendations/${recommendation.id}`}>Review</Link></Button>
      </div>
      {liveWorkspace?.executionTarget === "live" && (
        <CopilotApprovalDialog
          open
          onOpenChange={(next) => { if (!next && !executeLive.isPending) setLiveWorkspace(null); }}
          symbol={liveWorkspace.recommendation.symbol}
          side={liveWorkspace.recommendation.side}
          target="live"
          quantity={liveWorkspace.recommendation.qty}
          entryPrice={liveWorkspace.recommendation.entryPrice}
          stopPrice={liveWorkspace.recommendation.slPrice}
          targetPrice={liveWorkspace.recommendation.tpPrice}
          leverage={liveWorkspace.recommendation.leverage}
          maximumLoss={Math.abs(liveWorkspace.recommendation.entryPrice - liveWorkspace.recommendation.slPrice) * liveWorkspace.recommendation.qty}
          approvable={liveWorkspace.approvalReadiness.approvable}
          readinessReason={liveWorkspace.approvalReadiness.reason}
          pending={executeLive.isPending}
          onConfirm={(input) => executeLive.mutate(input)}
        />
      )}
    </div>
  );
}

function IntelligencePanel({ session }: { session: DashboardSession }) {
  const { section } = useSection();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const pause = useMutation({
    mutationFn: () => pauseAutopilot({ reason: "Trader paused new AutoPilot entries from the Dashboard" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard-session", section] });
      toast({ title: "AutoPilot paused", description: "New entries are paused. Protective position management and exits continue." });
    },
    onError: (error) => toast({ title: "Pause refused", description: error.message, variant: "destructive" }),
  });
  const mode = session.context.mode.configured;
  if (mode === "copilot") {
    return (
      <section className="terminal-panel overflow-hidden" aria-labelledby="intelligence-heading">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Intelligence mode</p><h2 id="intelligence-heading" className="mt-1 text-sm font-semibold">Co-Pilot recommendation</h2></div>
          <Badge variant="warning">Approval required</Badge>
        </div>
        <RecommendationPanel recommendation={session.activity.recommendations[0]} />
      </section>
    );
  }
  if (mode === "autopilot") {
    const autopilot = session.autopilot;
    return (
      <section className="terminal-panel overflow-hidden" aria-labelledby="intelligence-heading">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Intelligence mode</p><h2 id="intelligence-heading" className="mt-1 text-sm font-semibold">AutoPilot control</h2></div>
          <Badge variant={autopilot?.effectiveState === "AUTOPILOT_ENABLED" ? "success" : "warning"}>{autopilot?.effectiveState ?? "Not authorized"}</Badge>
        </div>
        <div className="space-y-4 p-4 text-sm">
          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">Configured mode</p>
            <p className="mt-1 font-semibold">AutoPilot selected</p>
            <p className="mt-3 text-xs text-muted-foreground">Effective authority</p>
            <p className="mt-1 font-mono text-xs">{session.context.mode.effectiveAuthority.replaceAll("_", " ")}</p>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div><dt className="text-muted-foreground">Authorized strategies</dt><dd className="mt-1 font-mono">{autopilot?.authorizedStrategies.length ?? 0}</dd></div>
            <div><dt className="text-muted-foreground">Open positions</dt><dd className="mt-1 font-mono">{session.runtime.openPositionCount}</dd></div>
            <div className="col-span-2"><dt className="text-muted-foreground">Safety state</dt><dd className="mt-1">{autopilot?.reason ?? "No active AutoPilot authority was found."}</dd></div>
          </dl>
          <div className="rounded-lg border border-live/30 bg-live/10 p-3 text-xs">The server-authorized mandate remains decisive. Pausing new entries never disables protective position management or exits.</div>
          {autopilot?.effectiveState === "AUTOPILOT_ENABLED" ? (
            <Button variant="destructive" className="w-full" disabled={pause.isPending} onClick={() => pause.mutate()}>{pause.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Pause new entries</Button>
          ) : (
            <p className="rounded-lg border p-3 text-center text-xs text-muted-foreground">Select AutoPilot above to enable it with the current shared trade setup.</p>
          )}
          <Button asChild variant="ghost" size="sm" className="w-full"><Link href="/autopilot">Advanced authority evidence <ChevronRight className="ml-1 h-4 w-4" /></Link></Button>
        </div>
      </section>
    );
  }
  return (
    <section className="terminal-panel overflow-hidden" aria-labelledby="intelligence-heading">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Intelligence mode</p><h2 id="intelligence-heading" className="mt-1 text-sm font-semibold">Brain intelligence</h2></div>
        <Badge variant="outline">Cannot execute</Badge>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <div className="flex gap-3 rounded-lg border border-demo/30 bg-demo/10 p-3">
          <BrainCircuit className="mt-0.5 h-5 w-5 shrink-0 text-demo" />
          <div><strong>Analysis only</strong><p className="mt-1 text-xs leading-5 text-muted-foreground">Brain ranks observations, evidence, uncertainty, and opportunities. You remain in control; this mode cannot execute.</p></div>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div><dt className="text-muted-foreground">Last scan</dt><dd className="mt-1 font-mono">{session.runtime.lastScanAt ? new Date(session.runtime.lastScanAt).toLocaleTimeString() : "Unavailable"}</dd></div>
          <div><dt className="text-muted-foreground">Signals today</dt><dd className="mt-1 font-mono">{session.runtime.tradesToday}</dd></div>
        </dl>
        <Button asChild variant="outline" className="w-full"><Link href="/ai-brain">Review reasoning and evidence <ChevronRight className="ml-1 h-4 w-4" /></Link></Button>
      </div>
    </section>
  );
}

function ActivityWorkspace({ session }: { session: DashboardSession }) {
  const queryClient = useQueryClient();
  const { section } = useSection();
  const [armedClose, setArmedClose] = useState<number | null>(null);
  const closeMutation = useMutation({
    mutationFn: (position: DashboardPosition) =>
      traderApi(`/trades/${position.id}/close`, { method: "POST" }),
    onSuccess: async () => {
      setArmedClose(null);
      await queryClient.invalidateQueries({ queryKey: ["dashboard-session", section] });
    },
  });

  return (
    <section className="terminal-panel overflow-hidden" aria-labelledby="activity-heading">
      <div className="border-b px-4 py-3"><h2 id="activity-heading" className="text-sm font-semibold">Trading activity</h2><p className="mt-1 text-xs text-muted-foreground">Account evidence only. Research projections are kept separate.</p></div>
      <Tabs defaultValue="positions">
        <div className="overflow-x-auto border-b px-3 pt-2">
          <TabsList className="bg-transparent">
            <TabsTrigger value="positions">Positions · {session.activity.positions.length}</TabsTrigger>
            <TabsTrigger value="orders">Pending orders</TabsTrigger>
            <TabsTrigger value="trades">Recent trades</TabsTrigger>
            <TabsTrigger value="portfolio">Portfolio</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="positions" className="m-0">
          {session.activity.positions.length === 0 ? (
            <div className="grid min-h-48 place-items-center p-6 text-center"><div><Activity className="mx-auto h-6 w-6 text-muted-foreground" /><p className="mt-3 text-sm font-medium">No open positions</p><p className="mt-1 text-xs text-muted-foreground">The account ledger confirmed there are no open non-backtest trades.</p></div></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-xs">
                <thead className="sticky top-0 bg-surface text-[10px] uppercase tracking-wide text-muted-foreground"><tr><th className="px-4 py-3">Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Stop</th><th>Target</th><th>Strategy</th><th>Protection</th><th className="pr-4 text-right">Action</th></tr></thead>
                <tbody className="divide-y">
                  {session.activity.positions.map((position) => (
                    <tr key={position.id}>
                      <td className="px-4 py-3 font-mono font-semibold">{position.symbol}</td>
                      <td className={position.side === "long" ? "text-positive" : "text-negative"}>{position.side}</td>
                      <td className="font-mono">{position.quantity}</td>
                      <td className="font-mono">{position.entryPrice}</td>
                      <td className="font-mono text-negative">{position.stopLoss}</td>
                      <td className="font-mono text-positive">{position.takeProfit}</td>
                      <td>{position.strategyName ?? "Unavailable"}</td>
                      <td><span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5 text-positive" /> {position.managementAuthority ?? "server managed"}</span></td>
                      <td className="pr-4 text-right">
                        {armedClose === position.id ? (
                          <span className="inline-flex gap-1">
                            <Button size="sm" variant="destructive" disabled={closeMutation.isPending} onClick={() => closeMutation.mutate(position)}>{closeMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirm close"}</Button>
                            <Button size="sm" variant="outline" onClick={() => setArmedClose(null)}>Cancel</Button>
                          </span>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => setArmedClose(position.id)}>Close position</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {closeMutation.error && <p className="border-t border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">Position close failed: {closeMutation.error.message}. The position remains open until the server confirms otherwise.</p>}
            </div>
          )}
        </TabsContent>
        <TabsContent value="orders" className="m-0 p-5">
          <div className="flex min-h-36 items-center gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4" role="status"><AlertTriangle className="h-5 w-5 shrink-0 text-warning" /><div><strong className="text-sm">Pending orders unavailable</strong><p className="mt-1 text-xs leading-5 text-muted-foreground">{session.activity.pendingOrders.reason} The interface will not misreport this state as zero orders.</p></div></div>
        </TabsContent>
        <TabsContent value="trades" className="m-0">
          {session.activity.recentTrades.length === 0 ? <p className="p-8 text-center text-sm text-muted-foreground">No completed account trades were found.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs"><thead className="bg-surface text-[10px] uppercase tracking-wide text-muted-foreground"><tr><th className="px-4 py-3">Market</th><th>Side</th><th>Result</th><th>Strategy</th><th>Environment</th><th>Closed</th></tr></thead><tbody className="divide-y">{session.activity.recentTrades.map((trade) => <tr key={trade.id}><td className="px-4 py-3 font-mono font-semibold">{trade.symbol}</td><td>{trade.side}</td><td className={cn("font-mono", (trade.pnl ?? 0) >= 0 ? "text-positive" : "text-negative")}>{trade.pnl === null ? "Unavailable" : money(trade.pnl)}</td><td>{trade.strategyName ?? "Unavailable"}</td><td>{trade.executionTarget}</td><td>{trade.exitTime ? new Date(trade.exitTime).toLocaleString() : "Unavailable"}</td></tr>)}</tbody></table></div>}
        </TabsContent>
        <TabsContent value="portfolio" className="m-0 p-5">
          <div className="grid gap-4 sm:grid-cols-3"><div className="rounded-lg border p-4"><p className="text-xs text-muted-foreground">Open positions</p><p className="mt-2 font-mono text-xl">{session.activity.positions.length}</p></div><div className="rounded-lg border p-4"><p className="text-xs text-muted-foreground">Marked exposure</p><p className="mt-2 text-sm text-muted-foreground">Unavailable</p></div><div className="rounded-lg border p-4"><p className="text-xs text-muted-foreground">Correlation projection</p><p className="mt-2 text-sm text-muted-foreground">Research view only</p></div></div>
          <Button asChild variant="outline" size="sm" className="mt-4"><Link href="/portfolio">Open portfolio research <ExternalLink className="ml-1 h-3.5 w-3.5" /></Link></Button>
        </TabsContent>
        <TabsContent value="performance" className="m-0 p-5">
          <div className="grid gap-4 sm:grid-cols-2">{(["demo", "live"] as const).map((target) => { const data = session.performance[target]; return <div key={target} className="rounded-lg border p-4"><div className="flex items-center justify-between"><p className="text-sm font-semibold capitalize">{target} evidence</p><Badge variant={target === "live" ? "warning" : "outline"}>{target}</Badge></div><dl className="mt-4 grid grid-cols-3 gap-3 text-xs"><div><dt className="text-muted-foreground">Sample</dt><dd className="mt-1 font-mono">{data.sampleSize}</dd></div><div><dt className="text-muted-foreground">P&amp;L</dt><dd className="mt-1 font-mono">{money(data.totalPnl)}</dd></div><div><dt className="text-muted-foreground">Win rate</dt><dd className="mt-1 font-mono">{data.winRate === null ? "Not enough data" : `${(data.winRate * 100).toFixed(1)}%`}</dd></div></dl></div>; })}</div>
          <Button asChild variant="outline" size="sm" className="mt-4"><Link href="/stats">Open full performance evidence <ExternalLink className="ml-1 h-3.5 w-3.5" /></Link></Button>
        </TabsContent>
      </Tabs>
    </section>
  );
}

export function TraderDashboard() {
  const { section } = useSection();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const configQuery = useGetConfig();
  const capabilitiesQuery = useQuery({
    queryKey: ["trader-capabilities", section],
    queryFn: () => traderApi<TraderCapabilities>("/capabilities"),
    staleTime: 30_000,
  });
  const sessionQuery = useQuery({
    queryKey: ["dashboard-session", section],
    queryFn: () => traderApi<DashboardSession>("/dashboard/session"),
    refetchInterval: 5_000,
  });
  const startBot = useStartBot();
  const stopBot = useStopBot();
  const [selectedSymbol, setSelectedSymbol] = useState<string>("");

  const session = sessionQuery.data;
  const config = configQuery.data as undefined | { marketType?: string; coinList?: string[]; forexSymbols?: string[] };
  const symbols = useMemo(() => {
    const fromActivity = [
      ...(session?.activity.positions.map((position) => position.symbol) ?? []),
      ...(session?.activity.recommendations.map((recommendation) => recommendation.symbol) ?? []),
    ];
    const configured = section === "forex" ? config?.forexSymbols ?? [] : config?.coinList ?? [];
    return [...new Set([...fromActivity, ...configured])];
  }, [config?.coinList, config?.forexSymbols, section, session?.activity.positions, session?.activity.recommendations]);
  useEffect(() => {
    if (!symbols.length) setSelectedSymbol("");
    else if (!selectedSymbol || !symbols.includes(selectedSymbol)) setSelectedSymbol(symbols[0]!);
  }, [selectedSymbol, symbols]);

  async function refreshRuntime() {
    await queryClient.invalidateQueries({ queryKey: ["dashboard-session", section] });
    await queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
  }
  function startRuntime() {
    startBot.mutate(undefined, {
      onSuccess: () => void refreshRuntime(),
      onError: (error) => toast({ title: "Start refused", description: error.message, variant: "destructive" }),
    });
  }
  function stopRuntime() {
    stopBot.mutate(undefined, {
      onSuccess: () => void refreshRuntime(),
      onError: (error) => toast({ title: "Stop failed", description: error.message, variant: "destructive" }),
    });
  }

  if (sessionQuery.isLoading) {
    return <div className="grid min-h-[60vh] place-items-center" role="status"><span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Building authoritative session workspace</span></div>;
  }
  if (sessionQuery.error || !session) {
    return (
      <div className="mx-auto grid min-h-[60vh] max-w-xl place-items-center text-center">
        <div className="terminal-panel border-destructive/40 p-8"><ShieldAlert className="mx-auto h-8 w-8 text-destructive" /><h1 className="mt-4 text-xl font-semibold">Dashboard state is unavailable</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">Account, risk, and execution values are unknown. No unavailable value is being treated as zero or safe.</p><Button className="mt-5" onClick={() => sessionQuery.refetch()}><RefreshCw className="mr-2 h-4 w-4" /> Retry authoritative read</Button></div>
      </div>
    );
  }

  const criticalAlerts = session.alerts.filter((alert) => alert.severity === "critical" || alert.persistent);
  const marketStale = session.health.marketData.state === "stale" || session.health.marketData.state === "unavailable";

  return (
    <div className="mx-auto max-w-[1800px] space-y-4">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Trader workspace</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Session control center</h1>
          <p className="mt-1 text-sm text-muted-foreground">One authoritative view of trading context, intelligence, risk, and activity.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DashboardTradeSetup
            readOnly={capabilitiesQuery.data?.readOnlyDemoAccount === true}
            autopilotActive={session.autopilot?.effectiveState === "AUTOPILOT_ENABLED"}
            onSaved={refreshRuntime}
          />
          <DashboardStrategySelector authorizedAutopilotStrategies={session.autopilot?.authorizedStrategies ?? []} />
          <Button
            size="sm"
            variant={session.runtime.running ? "destructive" : "default"}
            disabled={startBot.isPending || stopBot.isPending || capabilitiesQuery.data?.readOnlyDemoAccount}
            onClick={session.runtime.running ? stopRuntime : startRuntime}
          >
            {startBot.isPending || stopBot.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : session.runtime.running ? <Square className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
            {session.runtime.running ? "Stop runtime" : "Start runtime"}
          </Button>
        </div>
      </header>

      {criticalAlerts.length > 0 && (
        <div className="space-y-2">
          {criticalAlerts.map((alert) => (
            <div key={alert.id} className={cn("flex gap-3 rounded-lg border px-4 py-3 text-sm", alert.severity === "critical" ? "border-destructive/50 bg-destructive/10" : "border-warning/40 bg-warning/10")} role="alert">
              <AlertTriangle className={cn("mt-0.5 h-4 w-4 shrink-0", alert.severity === "critical" ? "text-destructive" : "text-warning")} />
              <div><strong className="capitalize">{alert.source.replaceAll("_", " ")}</strong><p className="mt-1 text-xs leading-5 text-muted-foreground">{alert.message}</p></div>
            </div>
          ))}
        </div>
      )}

      <section className="terminal-panel grid grid-cols-2 overflow-hidden sm:grid-cols-4 xl:grid-cols-7" aria-label="Account metrics">
        <MetricTile label="Available funds" metric={session.metrics.availableFunds} />
        <MetricTile label="Equity" metric={session.metrics.equity} />
        <MetricTile label="Margin used" metric={session.metrics.marginUsed} />
        <MetricTile label="Day P&L" metric={session.metrics.realizedDayPnl} />
        <MetricTile label="Exposure" metric={session.metrics.exposure} />
        <MetricTile label="Drawdown" metric={session.metrics.drawdown} />
        <div className="px-3 py-3 sm:px-4"><div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Risk status</div><div className={cn("mt-1.5 flex items-center gap-2 text-sm font-semibold", session.metrics.risk.state === "CLEAR" ? "text-positive" : "text-destructive")}>{session.metrics.risk.state === "CLEAR" ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}{session.metrics.risk.state}</div><div className="mt-1 text-[10px] text-muted-foreground">Protective management continues</div></div>
      </section>

      <section className="terminal-panel p-3" aria-label="Trading intelligence controls"><ModeControl session={session} /></section>

      <div className="grid gap-4 xl:grid-cols-12">
        <section className="terminal-panel overflow-hidden xl:col-span-8" aria-labelledby="market-chart-heading">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Market</p><h2 id="market-chart-heading" className="mt-1 text-sm font-semibold">Primary chart</h2></div>
            <label className="flex min-h-10 items-center gap-2 rounded-lg border bg-background px-3 text-xs"><span className="text-muted-foreground">Symbol</span><select value={selectedSymbol} onChange={(event) => setSelectedSymbol(event.target.value)} className="bg-transparent font-mono font-semibold outline-none" disabled={!symbols.length}>{symbols.length ? symbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>) : <option value="">Unavailable</option>}</select></label>
          </div>
          {selectedSymbol ? <MarketChart symbol={selectedSymbol} marketType={session.context.marketType} stale={marketStale} /> : <div className="grid h-[420px] place-items-center p-8 text-center text-sm text-muted-foreground">Configure at least one market in Settings before chart data can be requested.</div>}
        </section>
        <div className="xl:col-span-4"><IntelligencePanel session={session} /></div>
      </div>

      <ActivityWorkspace session={session} />

      {session.context.mode.configured === "brain" && <div className="terminal-panel p-4 sm:p-5"><MarketOverview /></div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="terminal-panel p-4"><div className="flex items-center gap-2"><CircleGauge className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">Broker, data & execution</h2></div><div className="mt-4 space-y-3">{Object.entries(session.health).map(([key, status]) => <div key={key} className="flex items-start justify-between gap-3 text-xs"><span className="capitalize text-muted-foreground">{key.replaceAll(/([A-Z])/g, " $1")}</span><span className="flex max-w-[65%] items-center gap-2 text-right"><StatusDot state={status.state} /><span>{status.label ?? status.state}{status.reason ? ` — ${status.reason}` : ""}</span></span></div>)}</div></section>
        <section className="terminal-panel p-4"><div className="flex items-center gap-2"><WalletCards className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">Account context</h2></div><dl className="mt-4 space-y-3 text-xs"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Account</dt><dd>{session.context.account.label}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Market</dt><dd>{session.context.market}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Broker</dt><dd className="capitalize">{session.context.broker}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Snapshot</dt><dd className="font-mono">{new Date(session.asOf).toLocaleTimeString()}</dd></div></dl><Button asChild variant="outline" size="sm" className="mt-4 w-full"><Link href="/settings">Manage account and connections</Link></Button></section>
        <section className="terminal-panel p-4"><div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">Safety boundaries</h2></div><ul className="mt-4 space-y-2 text-xs leading-5 text-muted-foreground">{session.limitations.map((limitation) => <li key={limitation} className="flex gap-2"><span aria-hidden="true">•</span><span>{limitation}</span></li>)}</ul></section>
      </div>
    </div>
  );
}

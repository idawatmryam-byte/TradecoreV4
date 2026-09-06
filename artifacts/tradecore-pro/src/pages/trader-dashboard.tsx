import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Square,
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
import {
  DashboardMetrics,
  DashboardConnectionStrip,
  operatingStatus,
  formatTradingNumber,
  managementLabel,
} from "@/components/dashboard-summary";
import { useSection } from "@/lib/section";
import {
  traderApi,
  type DashboardPosition,
  type DashboardRecommendation,
  type DashboardSession,
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

function ModeControl({
  session,
  readOnly,
}: {
  session: DashboardSession;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const { section } = useSection();
  const { toast } = useToast();
  const startRuntime = useStartBot();
  const internalDemo = session.context.environment.id === "CACTUS_DEMO";
  const [autopilotReview, setAutopilotReview] = useState(false);
  const mutation = useMutation({
    mutationFn: (mode: "research" | "copilot" | "autopilot") =>
      traderApi("/config", { method: "PUT", body: JSON.stringify({ mode }) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["dashboard-session", section],
      });
      await queryClient.invalidateQueries({
        queryKey: getGetBotStatusQueryKey(),
      });
      await queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() });
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
          "Broker sandbox AutoPilot is paused for the whole platform. Your shared setup is saved, but an administrator must clear the platform pause before activation.",
        );
      }
      let approvedBrain = controlCenter.versions.find(
        (version) => version.state === "DEMO_APPROVED",
      );
      if (!approvedBrain) {
        const controlBrain = controlCenter.versions.find(
          (version) =>
            version.implementation === "brain-v0-control" &&
            version.state === "COPILOT",
        );
        if (!controlBrain) {
          throw new Error(
            "No eligible AutoPilot release is available. A retired release cannot be restored; an administrator must publish a replacement.",
          );
        }
        approvedBrain = await transitionAutopilotBrainVersion(controlBrain.id, {
          toState: "DEMO_APPROVED",
          reason:
            "Trader approved the exact Demo AutoPilot release with the current shared setup",
          confirmation: "APPROVE_BRAIN_VERSION_FOR_DEMO",
        });
      }
      const enabledStrategies = strategies.filter(
        (strategy) => strategy.config.enabled && strategy.assignment.autopilot,
      );
      if (enabledStrategies.length === 0) {
        throw new Error(
          "Select at least one active AutoPilot strategy before enabling broker sandbox AutoPilot.",
        );
      }
      if (config.dailyLossLimitUsdt <= 0) {
        throw new Error(
          "Set a positive daily loss limit before enabling AutoPilot.",
        );
      }
      const maximumLeverage =
        config.marketType === "futures" ? config.leverage : 1;
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
        maximumMarketDataAgeSeconds: Math.min(
          300,
          Math.max(30, config.scanIntervalSeconds * 3),
        ),
        allowedTradingHoursUtc: [],
        permittedPhase7Actions: [
          "HOLD",
          "FREEZE",
          "REDUCE",
          "TIGHTEN_STOP",
          "APPLY_TRAILING",
          "EXIT",
        ],
        expiresAt: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1_000,
        ).toISOString(),
        confirmation: "CREATE_IMMUTABLE_DEMO_MANDATE",
      });
      const control = await activateAutopilot({
        mandateId: mandate.id,
        reason:
          "Trader enabled Demo AutoPilot from the Dashboard using the reviewed shared setup",
        confirmation: "ENABLE_DEMO_AUTOPILOT",
      });
      try {
        await startRuntime.mutateAsync(undefined);
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : "The runtime refused to start.";
        throw new Error(
          `AutoPilot authority was enabled, but the runtime did not start. ${detail}`,
        );
      }
      return control;
    },
    onSuccess: async () => {
      setAutopilotReview(false);
      toast({
        title: "Broker sandbox AutoPilot enabled",
        description:
          "AutoPilot is running with the same markets, trade limits, cadence, and selected strategies as your shared Dashboard setup.",
      });
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["dashboard-session", section],
        }),
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() }),
      ]);
    },
  });
  const modes = [
    {
      id: "brain",
      backend: "research" as const,
      label: "Brain",
      sub: "Analysis only",
    },
    {
      id: "copilot",
      backend: "copilot" as const,
      label: "Co-Pilot",
      sub: "Approval required",
    },
    {
      id: "autopilot",
      backend: "autopilot" as const,
      label: "AutoPilot",
      sub: internalDemo ? "Available now" : "Mandate controlled",
    },
  ] as const;

  return (
    <>
      <div
        className="grid grid-cols-3 gap-1 rounded-lg border bg-muted/20 p-1"
        aria-label="Trading intelligence mode"
      >
        {modes.map((mode) => {
          const selected = session.context.mode.configured === mode.id;
          return (
            <button
              key={mode.id}
              type="button"
              aria-pressed={selected}
              disabled={
                readOnly || mutation.isPending || enableAutopilot.isPending
              }
              onClick={() => {
                if (mode.id === "autopilot" && !internalDemo)
                  setAutopilotReview(true);
                else if (!selected && mode.backend)
                  mutation.mutate(mode.backend);
              }}
              className={cn(
                "min-h-10 rounded-md px-4 py-2 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                selected
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <span className="block text-xs font-semibold sm:text-sm">
                {mode.label}
              </span>
              <span className="sr-only"> · {mode.sub}</span>
            </button>
          );
        })}
      </div>
      {mutation.error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {mutation.error.message}
        </p>
      )}

      <Dialog open={autopilotReview} onOpenChange={setAutopilotReview}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable broker sandbox AutoPilot</DialogTitle>
            <DialogDescription>
              Broker-backed AutoPilot uses the same markets, sizing, protection,
              confidence, cadence, and strategy selection as Co-Pilot. Review
              the shared setup once, then enable it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border bg-muted/20 p-4">
              <strong className="block">Current shared trade setup</strong>
              <span className="mt-1 block text-muted-foreground">
                Use Trade setup and Strategies on the Dashboard to change what
                Co-Pilot and AutoPilot use.
              </span>
            </div>
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-xs leading-5">
              Enabling creates a bounded 30-day sandbox mandate with a 10%
              maximum drawdown cap. Every entry still requires fresh market
              data, reconciliation, deterministic risk approval, and the exact
              authorized strategy version. Real-money AutoPilot remains
              unavailable here.
            </div>
            {enableAutopilot.error && (
              <p
                className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
              >
                {enableAutopilot.error.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={enableAutopilot.isPending}
              onClick={() => setAutopilotReview(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                readOnly ||
                enableAutopilot.isPending ||
                session.autopilot?.effectiveState === "AUTOPILOT_ENABLED"
              }
              onClick={() => enableAutopilot.mutate()}
            >
              {enableAutopilot.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {session.autopilot?.effectiveState === "AUTOPILOT_ENABLED"
                ? "AutoPilot is active"
                : "Enable sandbox AutoPilot"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RecommendationPanel({
  recommendation,
  readOnly,
}: {
  recommendation: DashboardRecommendation | undefined;
  readOnly: boolean;
}) {
  const { section } = useSection();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [liveWorkspace, setLiveWorkspace] =
    useState<RecommendationWorkspace | null>(null);
  const [liveIdempotencyKey, setLiveIdempotencyKey] = useState("");

  async function refreshRecommendationState() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["dashboard-session", section],
      }),
      queryClient.invalidateQueries({ queryKey: getGetCopilotInboxQueryKey() }),
    ]);
  }

  function approvalBody(
    workspace: RecommendationWorkspace,
    confirmation: string,
    password?: string,
  ): ExecuteRecommendationBody {
    if (
      !workspace.decisionBundleFingerprint ||
      !workspace.executionTarget ||
      !workspace.approvalChallenge
    ) {
      throw new Error(
        "This recommendation no longer has complete approval evidence.",
      );
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
        throw new Error(
          "The execution target is unavailable; nothing was authorized.",
        );
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
      toast({
        title: "Approval refused",
        description: error.message,
        variant: "destructive",
      }),
  });
  const executeLive = useMutation({
    mutationFn: async ({
      confirmation,
      password,
    }: {
      confirmation: string;
      password?: string;
    }) => {
      if (!liveWorkspace)
        throw new Error("Live approval evidence is unavailable.");
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
      toast({
        title: "Approval refused",
        description: error.message,
        variant: "destructive",
      }),
  });

  const deny = useMutation({
    mutationFn: async () => {
      if (!recommendation) throw new Error("Recommendation is unavailable.");
      const workspace = await getRecommendationWorkspace(recommendation.id);
      if (!workspace.approvalChallenge) {
        throw new Error(
          "This recommendation is no longer awaiting a decision.",
        );
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
      toast({
        title: "Deny failed",
        description: error.message,
        variant: "destructive",
      }),
  });

  if (!recommendation) {
    return (
      <div className="grid min-h-64 place-items-center px-6 text-center">
        <div>
          <CheckCircle2 className="mx-auto h-7 w-7 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">
            No recommendation awaiting approval
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            This is a confirmed empty inbox, not an execution instruction.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link href="/copilot">Open recommendation history</Link>
          </Button>
        </div>
      </div>
    );
  }
  const long = recommendation.side === "long";
  const busy =
    readOnly || approve.isPending || deny.isPending || executeLive.isPending;
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge variant={long ? "success" : "destructive"}>
              {long ? (
                <ArrowUpRight className="mr-1 h-3 w-3" />
              ) : (
                <ArrowDownRight className="mr-1 h-3 w-3" />
              )}
              {recommendation.side.toUpperCase()}
            </Badge>
            <span className="font-mono text-lg font-semibold">
              {recommendation.symbol}
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {recommendation.strategyName ??
              recommendation.strategyId ??
              "Strategy unavailable"}
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-xl font-semibold">
            {Math.round(
              recommendation.confidence *
                (recommendation.confidence <= 1 ? 100 : 1),
            )}
            %
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            confidence
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/20 p-3 text-xs">
        <div>
          <dt className="text-muted-foreground">Proposed entry</dt>
          <dd className="mt-1 font-mono">{recommendation.entryPrice}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Position estimate</dt>
          <dd className="mt-1 font-mono">{recommendation.quantity}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Stop loss</dt>
          <dd className="mt-1 font-mono text-destructive">
            {recommendation.stopLoss}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Take profit</dt>
          <dd className="mt-1 font-mono text-success">
            {recommendation.takeProfit}
          </dd>
        </div>
      </dl>
      <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs leading-5">
        <strong className="block">Your approval is required.</strong>
        Approval revalidates price, expiry, risk, portfolio state, and the
        immutable plan fingerprint on the server.
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button size="sm" disabled={busy} onClick={() => approve.mutate()}>
          {approve.isPending && (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          )}
          {approve.isPending ? "Approving…" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => deny.mutate()}
        >
          {deny.isPending ? "Denying…" : "Deny"}
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`/dashboard/recommendations/${recommendation.id}`}>
            Review
          </Link>
        </Button>
      </div>
      {liveWorkspace?.executionTarget === "live" && (
        <CopilotApprovalDialog
          open
          onOpenChange={(next) => {
            if (!next && !executeLive.isPending) setLiveWorkspace(null);
          }}
          symbol={liveWorkspace.recommendation.symbol}
          side={liveWorkspace.recommendation.side}
          target="live"
          quantity={liveWorkspace.recommendation.qty}
          entryPrice={liveWorkspace.recommendation.entryPrice}
          stopPrice={liveWorkspace.recommendation.slPrice}
          targetPrice={liveWorkspace.recommendation.tpPrice}
          leverage={liveWorkspace.recommendation.leverage}
          maximumLoss={
            Math.abs(
              liveWorkspace.recommendation.entryPrice -
                liveWorkspace.recommendation.slPrice,
            ) * liveWorkspace.recommendation.qty
          }
          approvable={!readOnly && liveWorkspace.approvalReadiness.approvable}
          readinessReason={liveWorkspace.approvalReadiness.reason}
          pending={executeLive.isPending}
          onConfirm={(input) => executeLive.mutate(input)}
        />
      )}
    </div>
  );
}

function IntelligencePanel({
  session,
  readOnly,
  runtimeControls,
}: {
  session: DashboardSession;
  readOnly: boolean;
  runtimeControls: React.ReactNode;
}) {
  const { section } = useSection();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mode = session.context.mode.configured;
  const internalDemo = session.context.environment.id === "CACTUS_DEMO";
  const status = operatingStatus(session);
  const pause = useMutation({
    mutationFn: () =>
      pauseAutopilot({
        reason: "Trader paused new AutoPilot entries from the Dashboard",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["dashboard-session", section],
        }),
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() }),
      ]);
      toast({
        title: "AutoPilot paused",
        description:
          "New entries are paused. Protective position management and exits continue.",
      });
    },
    onError: (error) =>
      toast({
        title: "Pause refused",
        description: error.message,
        variant: "destructive",
      }),
  });
  return (
    <section
      className="dashboard-card flex h-full min-w-0 flex-col"
      aria-labelledby="intelligence-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <h2
          id="intelligence-heading"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <BrainCircuit className="h-4 w-4 text-primary" />
          AI activity
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              status.active ? "bg-success" : "bg-warning",
            )}
          />
          {session.runtime.running ? "Runtime running" : "Stopped"}
        </span>
      </div>
      <div className="px-4 pt-3">
        <h3 className="text-xl font-semibold tracking-tight">{status.title}</h3>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {status.detail}
        </p>
      </div>
      {mode === "copilot" ? (
        <RecommendationPanel
          recommendation={session.activity.recommendations[0]}
          readOnly={readOnly}
        />
      ) : (
        <div className="space-y-3 px-4 pt-3">
          <div className="rounded-lg border border-primary/15 bg-primary/5 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Latest runtime activity
            </p>
            <p className="mt-2 text-sm font-semibold">
              {session.runtime.lastScanAt
                ? "Market scan completed"
                : "No scan recorded"}
            </p>
            {!internalDemo && (
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                {mode === "brain"
                  ? "Analysis only. This mode cannot execute trades."
                  : (session.autopilot?.reason ??
                    "No active AutoPilot authority was found.")}
              </p>
            )}
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" />
              {session.runtime.lastScanAt
                ? new Date(session.runtime.lastScanAt).toLocaleString()
                : "Last scan unavailable"}
            </p>
          </div>
          {session.activity.positions.slice(0, 2).map((position) => (
            <div
              key={position.id}
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-xs"
            >
              <span className="font-semibold">{position.symbol}</span>
              <span className="text-muted-foreground">
                {managementLabel(position.managementAuthority)}
              </span>
            </div>
          ))}
          {session.activity.positions.length > 2 && (
            <a
              href="#activity-heading"
              className="block text-xs font-medium text-primary"
            >
              View all {session.activity.positions.length} positions
            </a>
          )}
          {mode === "autopilot" &&
            !internalDemo &&
            session.autopilot?.effectiveState === "AUTOPILOT_ENABLED" && (
              <>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={readOnly || pause.isPending}
                  onClick={() => pause.mutate()}
                >
                  {pause.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Pause new entries
                </Button>
                <p className="text-xs leading-5 text-muted-foreground">
                  Pausing entries keeps protective management and exits running.
                </p>
              </>
            )}

          <Button asChild variant="outline" className="w-full">
            <Link
              href={mode === "brain" ? "/ai-brain" : "/settings?view=trading"}
            >
              {mode === "brain"
                ? "Review reasoning and evidence"
                : "Review entry settings"}
              <ChevronRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      )}
      <div className="mt-auto space-y-2 px-4 pb-4 pt-2">
        <Link
          href={mode === "copilot" ? "/copilot" : "/decisions"}
          className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-primary"
        >
          View decision history
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
        {mode === "autopilot" && !internalDemo && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Authority details
            </summary>
            <dl className="mt-2 space-y-2 rounded-lg border p-3">
              <div>
                <dt className="text-muted-foreground">Effective authority</dt>
                <dd className="mt-1 break-words">
                  {session.context.mode.effectiveAuthority.replaceAll("_", " ")}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Authorized strategies</dt>
                <dd>{session.autopilot?.authorizedStrategies.length ?? 0}</dd>
              </div>
            </dl>
            <Link href="/autopilot" className="mt-2 inline-block text-primary">
              Advanced authority evidence
            </Link>
          </details>
        )}
        {runtimeControls}
      </div>
    </section>
  );
}
function ActivityWorkspace({
  session,
  readOnly,
}: {
  session: DashboardSession;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const { section } = useSection();
  const [armedClose, setArmedClose] = useState<number | null>(null);
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const detailsTrigger = useRef<HTMLButtonElement | null>(null);
  const details = session.activity.positions.find(
    (position) => position.id === detailsId,
  );
  const closeMutation = useMutation({
    mutationFn: (position: DashboardPosition) =>
      traderApi(`/trades/${position.id}/close`, { method: "POST" }),
    onSuccess: async () => {
      setArmedClose(null);
      await queryClient.invalidateQueries({
        queryKey: ["dashboard-session", section],
      });
    },
  });

  return (
    <section
      className="dashboard-card overflow-hidden"
      aria-labelledby="activity-heading"
    >
      <h2 id="activity-heading" className="sr-only">
        Trading activity
      </h2>
      <Tabs defaultValue="positions">
        <div className="flex items-center justify-between gap-3 overflow-x-auto border-b px-3 pt-2">
          <TabsList className="bg-transparent">
            <TabsTrigger value="positions">
              Open positions · {session.activity.positions.length}
            </TabsTrigger>
            <TabsTrigger value="orders">Pending orders</TabsTrigger>
            <TabsTrigger value="trades">Recent trades</TabsTrigger>
            <TabsTrigger value="portfolio">Portfolio</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
          </TabsList>
          <Link
            href="/trades"
            className="hidden shrink-0 pr-2 text-xs font-medium text-primary sm:block"
          >
            View all activity
          </Link>
        </div>
        <TabsContent value="positions" className="m-0">
          {session.activity.positions.length === 0 ? (
            <div className="grid min-h-48 place-items-center p-6 text-center">
              <div>
                <Activity className="mx-auto h-6 w-6 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">No open positions</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The account ledger confirmed there are no open non-backtest
                  trades.
                </p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-xs">
                <thead className="sticky top-0 bg-surface text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Market</th>
                    <th>Side</th>
                    <th>Size</th>
                    <th>Entry</th>
                    <th>Stop</th>
                    <th>Target</th>
                    <th>Strategy</th>
                    <th>Protection</th>
                    <th className="pr-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {session.activity.positions.map((position) => (
                    <tr key={position.id}>
                      <td className="px-4 py-3 font-mono font-semibold">
                        {position.symbol}
                      </td>
                      <td>
                        <Badge
                          variant={
                            position.side === "long" ? "success" : "destructive"
                          }
                          className="capitalize"
                        >
                          {position.side}
                        </Badge>
                      </td>
                      <td className="font-mono">
                        {formatTradingNumber(position.quantity)}
                      </td>
                      <td className="font-mono">
                        {formatTradingNumber(position.entryPrice)}
                      </td>
                      <td className="font-mono text-destructive">
                        {formatTradingNumber(position.stopLoss)}
                      </td>
                      <td className="font-mono text-success">
                        {formatTradingNumber(position.takeProfit)}
                      </td>
                      <td>{position.strategyName ?? "Unavailable"}</td>
                      <td>
                        <span className="inline-flex items-center gap-1">
                          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />{" "}
                          {managementLabel(position.managementAuthority)}
                        </span>
                      </td>
                      <td className="pr-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`View ${position.symbol} position details`}
                          onClick={(event) => {
                            detailsTrigger.current = event.currentTarget;
                            setDetailsId(position.id);
                          }}
                        >
                          Details
                        </Button>
                        {armedClose === position.id ? (
                          <span className="inline-flex gap-1">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={readOnly || closeMutation.isPending}
                              onClick={() => closeMutation.mutate(position)}
                            >
                              {closeMutation.isPending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                "Confirm close"
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={closeMutation.isPending}
                              onClick={() => setArmedClose(null)}
                            >
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={readOnly || closeMutation.isPending}
                            onClick={() => {
                              closeMutation.reset();
                              setArmedClose(position.id);
                            }}
                          >
                            Close position
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {closeMutation.error && (
                <p
                  className="border-t border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                  role="alert"
                >
                  Position close failed: {closeMutation.error.message}. The
                  position remains open until the server confirms otherwise.
                </p>
              )}
            </div>
          )}
        </TabsContent>
        <TabsContent value="orders" className="m-0 p-5">
          <div
            className="flex min-h-36 items-center gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4"
            role="status"
          >
            <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
            <div>
              <strong className="text-sm">Pending orders unavailable</strong>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {session.activity.pendingOrders.reason} The interface will not
                misreport this state as zero orders.
              </p>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="trades" className="m-0">
          {session.activity.recentTrades.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No completed account trades were found.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="bg-surface text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Market</th>
                    <th>Side</th>
                    <th>Result</th>
                    <th>Strategy</th>
                    <th>Environment</th>
                    <th>Closed</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {session.activity.recentTrades.map((trade) => (
                    <tr key={trade.id}>
                      <td className="px-4 py-3 font-mono font-semibold">
                        {trade.symbol}
                      </td>
                      <td>{trade.side}</td>
                      <td
                        className={cn(
                          "font-mono",
                          (trade.pnl ?? 0) >= 0
                            ? "text-success"
                            : "text-destructive",
                        )}
                      >
                        {trade.pnl === null ? "Unavailable" : money(trade.pnl)}
                      </td>
                      <td>{trade.strategyName ?? "Unavailable"}</td>
                      <td>{trade.executionTarget}</td>
                      <td>
                        {trade.exitTime
                          ? new Date(trade.exitTime).toLocaleString()
                          : "Unavailable"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
        <TabsContent value="portfolio" className="m-0 p-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">Open positions</p>
              <p className="mt-2 font-mono text-xl">
                {session.activity.positions.length}
              </p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">Marked exposure</p>
              <p className="mt-2 text-sm text-muted-foreground">Unavailable</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">
                Correlation projection
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Research view only
              </p>
            </div>
          </div>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link href="/portfolio">
              Open portfolio research{" "}
              <ExternalLink className="ml-1 h-3.5 w-3.5" />
            </Link>
          </Button>
        </TabsContent>
        <TabsContent value="performance" className="m-0 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            {(["demo", "live"] as const).map((target) => {
              const data = session.performance[target];
              return (
                <div key={target} className="rounded-lg border p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold capitalize">
                      {target} evidence
                    </p>
                    <Badge variant={target === "live" ? "warning" : "outline"}>
                      {target}
                    </Badge>
                  </div>
                  <dl className="mt-4 grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Sample</dt>
                      <dd className="mt-1 font-mono">{data.sampleSize}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">P&amp;L</dt>
                      <dd className="mt-1 font-mono">{money(data.totalPnl)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Win rate</dt>
                      <dd className="mt-1 font-mono">
                        {data.winRate === null
                          ? "Not enough data"
                          : `${(data.winRate * 100).toFixed(1)}%`}
                      </dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link href="/stats">
              Open full performance evidence{" "}
              <ExternalLink className="ml-1 h-3.5 w-3.5" />
            </Link>
          </Button>
        </TabsContent>
      </Tabs>
      <Dialog
        open={Boolean(details)}
        onOpenChange={(open) => {
          if (!open) setDetailsId(null);
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            detailsTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{details?.symbol} position details</DialogTitle>
            <DialogDescription>
              Account ledger values at the latest dashboard refresh. Display
              rounding does not change your orders.
            </DialogDescription>
          </DialogHeader>
          {details && (
            <>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                {[
                  ["Side", details.side],
                  ["Quantity", details.quantity],
                  ["Entry", details.entryPrice],
                  ["Stop loss", details.stopLoss],
                  ["Take profit", details.takeProfit],
                  ["Strategy", details.strategyName ?? "Unavailable"],
                  ["Environment", details.executionTarget],
                  ["Management", managementLabel(details.managementAuthority)],
                  ["Opened", new Date(details.entryTime).toLocaleString()],
                  ["Unrealized P&L", "Unavailable in this account snapshot"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 break-words font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs leading-5 text-muted-foreground">
                Management names describe the assigned rules; they do not
                confirm broker-side protection.
              </p>
              <Button asChild variant="outline">
                <Link href="/trades">View trade history and thesis</Link>
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function TraderDashboard() {
  const { section } = useSection();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const configQuery = useGetConfig({
    query: { queryKey: getGetConfigQueryKey() },
  });
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
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const runtimeTrigger = useRef<HTMLButtonElement>(null);
  const session = sessionQuery.data;
  const symbols = useMemo(
    () => [
      ...new Set([
        ...(session?.activity.positions.map((position) => position.symbol) ??
          []),
        ...(session?.activity.recommendations.map(
          (recommendation) => recommendation.symbol,
        ) ?? []),
        ...(configQuery.data?.pairs ?? []),
      ]),
    ],
    [
      configQuery.data?.pairs,
      session?.activity.positions,
      session?.activity.recommendations,
    ],
  );
  useEffect(() => {
    if (!symbols.includes(selectedSymbol)) setSelectedSymbol(symbols[0] ?? "");
  }, [selectedSymbol, symbols]);
  useEffect(() => {
    setConfirmStop(false);
  }, [section]);
  async function refreshRuntime() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["dashboard-session", section],
      }),
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() }),
    ]);
  }
  function startRuntime() {
    startBot.mutate(undefined, {
      onSuccess: () => void refreshRuntime(),
      onError: (error) =>
        toast({
          title: "Start refused",
          description: error.message,
          variant: "destructive",
        }),
    });
  }
  function stopRuntime() {
    stopBot.mutate(undefined, {
      onSuccess: () => {
        setConfirmStop(false);
        void refreshRuntime();
      },
      onError: (error) =>
        toast({
          title: "Stop failed",
          description: error.message,
          variant: "destructive",
        }),
    });
  }
  if (sessionQuery.isLoading)
    return (
      <div className="grid min-h-[60vh] place-items-center" role="status">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading trading overview
        </span>
      </div>
    );
  if (sessionQuery.error || !session)
    return (
      <div className="mx-auto grid min-h-[60vh] max-w-xl place-items-center text-center">
        <div className="dashboard-card border-destructive/40 p-8">
          <ShieldAlert className="mx-auto h-8 w-8 text-destructive" />
          <h1 className="mt-4 text-xl font-semibold">
            Dashboard state is unavailable
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Account, risk, and execution values are unknown. No unavailable
            value is being treated as zero or safe.
          </p>
          <Button className="mt-5" onClick={() => sessionQuery.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry authoritative read
          </Button>
        </div>
      </div>
    );
  const readOnly =
    !capabilitiesQuery.data ||
    capabilitiesQuery.isError ||
    capabilitiesQuery.data.readOnlyDemoAccount;
  const criticalAlerts = session.alerts.filter(
    (alert) => alert.severity === "critical" || alert.persistent,
  );
  const marketStale = session.health.marketData.state !== "available";
  const status = operatingStatus(session);
  const chartPositions = session.activity.positions.filter(
    (position) => position.symbol === selectedSymbol,
  );
  const chartPosition =
    chartPositions.length === 1 ? chartPositions[0] : undefined;
  const runtimeControls = (
    <Button
      ref={runtimeTrigger}
      size="sm"
      variant={session.runtime.running ? "outline" : "default"}
      className={cn(
        "w-full",
        session.runtime.running &&
          "border-destructive/35 text-destructive hover:bg-destructive/5 hover:text-destructive",
      )}
      disabled={readOnly || startBot.isPending || stopBot.isPending}
      onClick={
        session.runtime.running ? () => setConfirmStop(true) : startRuntime
      }
    >
      {startBot.isPending || stopBot.isPending ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : session.runtime.running ? (
        <Square className="mr-2 h-4 w-4" />
      ) : (
        <Play className="mr-2 h-4 w-4" />
      )}
      {session.runtime.running ? "Emergency controls" : "Start runtime"}
    </Button>
  );
  return (
    <div className="dashboard-overview mx-auto max-w-[1800px] space-y-4">
      <header className="flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight lg:text-3xl">
            Trading overview
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {status.title}. {status.detail}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-auto">
            <ModeControl key={section} session={session} readOnly={readOnly} />
          </div>
          <DashboardTradeSetup
            readOnly={readOnly}
            autopilotActive={
              session.autopilot?.effectiveState === "AUTOPILOT_ENABLED"
            }
            onSaved={refreshRuntime}
          />
          <DashboardStrategySelector
            authorizedAutopilotStrategies={
              session.autopilot?.authorizedStrategies ?? []
            }
          />
        </div>
      </header>
      {capabilitiesQuery.isError && (
        <p
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm"
          role="alert"
        >
          Trading permissions are unavailable. Controls remain disabled until
          permissions can be verified.
        </p>
      )}
      {criticalAlerts.map((alert) => (
        <div
          key={alert.id}
          className={cn(
            "flex gap-3 rounded-lg border px-4 py-3 text-sm",
            alert.severity === "critical"
              ? "border-destructive/50 bg-destructive/10"
              : "border-warning/40 bg-warning/10",
          )}
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <strong className="capitalize">
              {alert.source.replaceAll("_", " ")}
            </strong>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {alert.message}
            </p>
          </div>
        </div>
      ))}
      <DashboardMetrics session={session} />
      <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(340px,1fr)]">
        <section
          className="dashboard-card min-w-0 overflow-hidden"
          aria-labelledby="market-chart-heading"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3">
            <h2
              id="market-chart-heading"
              className="flex items-center gap-2 text-sm font-semibold"
            >
              <Activity className="h-4 w-4 text-primary" />
              Market chart
            </h2>
            <label className="flex min-h-10 max-w-full items-center gap-2 rounded-lg border bg-background px-3 text-xs">
              <span className="text-muted-foreground">Symbol</span>
              <select
                aria-label="Chart symbol"
                value={selectedSymbol}
                onChange={(event) => setSelectedSymbol(event.target.value)}
                className="min-w-0 bg-transparent font-semibold"
                disabled={!symbols.length}
              >
                {symbols.length ? (
                  symbols.map((symbol) => (
                    <option key={symbol} value={symbol}>
                      {symbol}
                    </option>
                  ))
                ) : (
                  <option value="">Unavailable</option>
                )}
              </select>
            </label>
          </div>
          {selectedSymbol ? (
            <MarketChart
              key={`${section}:${selectedSymbol}`}
              symbol={selectedSymbol}
              marketType={session.context.marketType}
              stale={marketStale}
              position={
                chartPosition
                  ? {
                      entryPrice: chartPosition.entryPrice,
                      stopLoss: chartPosition.stopLoss,
                      takeProfit: chartPosition.takeProfit,
                    }
                  : undefined
              }
            />
          ) : (
            <div className="grid h-[360px] place-items-center p-8 text-center text-sm text-muted-foreground">
              <div>
                <p>No chart markets configured.</p>
                <Link
                  href="/settings?view=trading"
                  className="mt-2 inline-block font-medium text-primary"
                >
                  Configure markets in Settings
                </Link>
              </div>
            </div>
          )}
        </section>
        <IntelligencePanel
          key={section}
          session={session}
          readOnly={readOnly}
          runtimeControls={runtimeControls}
        />
      </div>
      <ActivityWorkspace key={section} session={session} readOnly={readOnly} />
      <DashboardConnectionStrip session={session} />
      {session.context.mode.configured === "brain" && (
        <details className="dashboard-card p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            Market research overview
          </summary>
          <div className="mt-4">
            <MarketOverview />
          </div>
        </details>
      )}
      <Dialog
        open={confirmStop}
        onOpenChange={(open) => {
          if (!stopBot.isPending) setConfirmStop(open);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            runtimeTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Stop the trading runtime?</DialogTitle>
            <DialogDescription>
              This stops market scanning and automated position management for{" "}
              {session.context.market}. It does not close your positions.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <strong>
              {session.runtime.openPositionCount} open position
              {session.runtime.openPositionCount === 1 ? "" : "s"}
            </strong>
            <p className="mt-2 leading-6">
              Review these positions before stopping. Existing broker-side
              orders are not cancelled by this control. Start the runtime again
              to resume automated management.
            </p>
          </div>
          {stopBot.error && (
            <p role="alert" className="text-sm text-destructive">
              {stopBot.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={stopBot.isPending}
              onClick={() => setConfirmStop(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={readOnly || stopBot.isPending}
              onClick={stopRuntime}
            >
              {stopBot.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Stop runtime
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

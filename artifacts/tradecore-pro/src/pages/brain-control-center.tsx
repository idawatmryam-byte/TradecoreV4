import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  activateAutopilot,
  createAutopilotMandate,
  getGetAutopilotControlQueryKey,
  getGetAutopilotForwardSoakQueryKey,
  pauseAutopilot,
  resumeAutopilot,
  revokeAutopilotMandate,
  transitionAutopilotBrainVersion,
  useGetAutopilotControl,
  useGetAutopilotForwardSoak,
  useGetConfig,
  useGetStrategies,
  type AutopilotBrainVersion,
  type AutopilotControl,
  type AutopilotMandate,
  type CreateAutopilotMandateRequest,
} from "@workspace/api-client-react";
import { AlertTriangle, BrainCircuit, Clock3, Pause, Play, ShieldCheck, XOctagon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/patterns";
import { useToast } from "@/components/ui/use-toast";

interface ControlSnapshot {
  control?: AutopilotControl;
  mandate?: AutopilotMandate | null;
  brainVersion?: AutopilotBrainVersion | null;
  mandateState?: { state?: string; reason?: string } | null;
}

interface AuditEvent {
  id?: number;
  eventType?: string;
  reasonCode?: string;
  reason?: string;
  fromState?: string | null;
  toState?: string | null;
  occurredAt?: string;
  fingerprint?: string | null;
}

function errorMessage(error: unknown): string {
  const data = (error as { data?: { error?: unknown } | null })?.data;
  return typeof data?.error === "string" ? data.error : error instanceof Error ? error.message : "The safety action was refused";
}

function shortFingerprint(value?: string | null): string {
  return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—";
}

function numberField(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function BrainControlCenter() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const controlQuery = useGetAutopilotControl({ query: { queryKey: getGetAutopilotControlQueryKey(), refetchInterval: 10_000 } });
  const soakQuery = useGetAutopilotForwardSoak({ query: { queryKey: getGetAutopilotForwardSoakQueryKey(), refetchInterval: 30_000 } });
  const configQuery = useGetConfig();
  const strategiesQuery = useGetStrategies();
  const snapshot = (controlQuery.data?.snapshot ?? {}) as ControlSnapshot;
  const control = snapshot.control;
  const mandate = snapshot.mandate;
  const brain = snapshot.brainVersion;
  const controlBrain = controlQuery.data?.versions.find((item) => item.implementation === "brain-v0-control");
  const approvedBrain = controlQuery.data?.versions.find((item) => item.state === "DEMO_APPROVED");
  const enabledStrategies = strategiesQuery.data?.filter((item) => item.config.enabled) ?? [];
  const config = configQuery.data;
  const [reason, setReason] = useState("Operator reviewed the exact Demo Autopilot safety state");
  const [expiresAt, setExpiresAt] = useState("");
  const [positionSize, setPositionSize] = useState("");
  const [dailyLoss, setDailyLoss] = useState("");
  const [drawdown, setDrawdown] = useState("10");
  const [marketAge, setMarketAge] = useState("30");

  useEffect(() => {
    if (!expiresAt) {
      const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      setExpiresAt(expiry.toISOString().slice(0, 16));
    }
    if (config && !positionSize) setPositionSize(String(config.positionSizeUsdt));
    if (config && !dailyLoss) setDailyLoss(String(config.dailyLossLimitUsdt));
  }, [config, dailyLoss, expiresAt, positionSize]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetAutopilotControlQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetAutopilotForwardSoakQueryKey() }),
    ]);
  };

  const action = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      await refresh();
      toast({ title: "Demo Autopilot control updated", description: "The durable state and audit history were refreshed." });
    },
    onError: (error) => toast({ title: "Safety action refused", description: errorMessage(error), variant: "destructive" }),
  });

  const mandateRequest = useMemo<CreateAutopilotMandateRequest | null>(() => {
    if (!config || !approvedBrain || enabledStrategies.length === 0 || !expiresAt) return null;
    return {
      brainVersionId: approvedBrain.id,
      instruments: config.pairs,
      strategyIds: enabledStrategies.map((item) => item.strategyId),
      maximumPositionSizeUsdt: numberField(positionSize, config.positionSizeUsdt),
      maximumLeverage: config.marketType === "futures" ? config.leverage : 1,
      maximumPortfolioRiskPercent: config.maxPortfolioRiskPercent,
      maximumSymbolExposurePercent: config.maxSymbolConcentrationPercent,
      maximumNetExposurePercent: config.maxNetExposurePercent,
      maximumCorrelatedExposurePercent: config.maxCorrelatedExposurePercent,
      dailyLossLimitUsdt: numberField(dailyLoss, config.dailyLossLimitUsdt),
      maximumDrawdownPercent: numberField(drawdown, 10),
      maximumConcurrentPositions: config.maxOpenPositions,
      maximumMarketDataAgeSeconds: numberField(marketAge, 30),
      allowedTradingHoursUtc: [],
      permittedPhase7Actions: ["HOLD", "FREEZE", "REDUCE", "TIGHTEN_STOP", "APPLY_TRAILING", "EXIT"],
      expiresAt: new Date(expiresAt).toISOString(),
      confirmation: "CREATE_IMMUTABLE_DEMO_MANDATE",
    };
  }, [approvedBrain, config, dailyLoss, drawdown, enabledStrategies, expiresAt, marketAge, positionSize]);

  const stateTone = control?.state === "AUTOPILOT_ENABLED" ? "success" : control?.state === "AUTOPILOT_PAUSED" ? "warning" : "destructive";
  const metrics = (soakQuery.data?.metrics ?? {}) as Record<string, unknown>;
  const events = (controlQuery.data?.events ?? []) as AuditEvent[];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BrainCircuit}
        title="Brain Control Center"
        description="Human-controlled authority, immutable mandates, safety state, and forward evidence for Phase 10."
      />

      <div className="rounded-xl border-2 border-emerald-500/60 bg-emerald-500/10 p-4" role="status">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
          <div>
            <p className="font-semibold">DEMO AUTOPILOT · NO LIVE AUTHORITY</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Autonomous entries are restricted to simulated Demo, Binance Spot testnet, Binance Futures Demo, and OANDA practice. Pausing entries does not disable protective position management or exits.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Autonomous authority</CardTitle>
                <CardDescription>Current durable projection and operator-visible refusal reason.</CardDescription>
              </div>
              <Badge variant={stateTone}>{control?.state ?? "AUTOPILOT_BLOCKED"}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{control?.reasonCode ?? "MANDATE_MISSING"}</p>
              <p className="mt-1 text-sm">{control?.reason ?? "No Demo Autopilot mandate is active."}</p>
            </div>
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div><span className="text-muted-foreground">Authority</span><p className="font-mono">{mandate?.executionAuthority ?? "none"}</p></div>
              <div><span className="text-muted-foreground">Global suspension</span><p>{controlQuery.data?.globalSuspended ? "ACTIVE" : "clear"}</p></div>
              <div><span className="text-muted-foreground">Config suspension</span><p>{control?.configSuspended ? "ACTIVE" : "clear"}</p></div>
              <div><span className="text-muted-foreground">Mandate lifecycle</span><p>{snapshot.mandateState?.state ?? "missing"}</p></div>
            </div>
            <div>
              <Label htmlFor="operator-reason">Operator reason</Label>
              <Textarea id="operator-reason" value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2" />
            </div>
            <div className="flex flex-wrap gap-2">
              {control?.state === "AUTOPILOT_ENABLED" ? (
                <Button variant="outline" disabled={action.isPending || reason.trim().length < 8} onClick={() => action.mutate(() => pauseAutopilot({ reason }))}>
                  <Pause className="mr-2 h-4 w-4" /> Halt new entries
                </Button>
              ) : mandate ? (
                <Button disabled={action.isPending || reason.trim().length < 8} onClick={() => action.mutate(() => resumeAutopilot({ reason, confirmation: "RESUME_DEMO_AUTOPILOT" }))}>
                  <Play className="mr-2 h-4 w-4" /> Revalidate and resume
                </Button>
              ) : null}
              {mandate && (
                <Button variant="destructive" disabled={action.isPending || reason.trim().length < 8} onClick={() => {
                  if (window.confirm("Irrevocably revoke this exact Demo Autopilot mandate? Protective exits remain available.")) {
                    action.mutate(() => revokeAutopilotMandate(mandate.id, { reason, confirmation: "REVOKE_DEMO_AUTOPILOT_MANDATE" }));
                  }
                }}><XOctagon className="mr-2 h-4 w-4" /> Revoke mandate</Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Brain lifecycle</CardTitle><CardDescription>No lifecycle transition silently grants authority.</CardDescription></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div><span className="text-muted-foreground">Version</span><p className="font-medium">{brain?.version ?? controlBrain?.version ?? "—"}</p></div>
            <div><span className="text-muted-foreground">Stage</span><p>{brain?.state ?? controlBrain?.state ?? "—"}</p></div>
            <div><span className="text-muted-foreground">Fingerprint</span><p className="font-mono text-xs">{shortFingerprint(brain?.fingerprint ?? controlBrain?.fingerprint)}</p></div>
            {controlBrain?.state === "COPILOT" && (
              <Button className="w-full" disabled={action.isPending || reason.trim().length < 8} onClick={() => action.mutate(() => transitionAutopilotBrainVersion(controlBrain.id, { toState: "DEMO_APPROVED", reason, confirmation: "APPROVE_BRAIN_VERSION_FOR_DEMO" }))}>
                Approve exact Brain V0 for Demo
              </Button>
            )}
            {(controlBrain?.state === "SHADOW" || controlBrain?.state === "SUSPENDED") && (
              <Button className="w-full" variant="outline" disabled={action.isPending || reason.trim().length < 8} onClick={() => action.mutate(() => transitionAutopilotBrainVersion(controlBrain.id, { toState: "COPILOT", reason, confirmation: "TRANSITION_BRAIN_VERSION_TO_COPILOT" }))}>
                Return Brain V0 to Co-Pilot
              </Button>
            )}
            {approvedBrain && (
              <Button variant="outline" className="w-full" disabled={action.isPending || reason.trim().length < 8} onClick={() => action.mutate(() => transitionAutopilotBrainVersion(approvedBrain.id, { toState: "SHADOW", reason, confirmation: "RETURN_BRAIN_VERSION_TO_SHADOW" }))}>
                Return brain to Shadow
              </Button>
            )}
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Registered versions</p>
              {(controlQuery.data?.versions ?? []).map((version) => (
                <div key={version.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><p className="font-medium">{version.version}</p><p className="truncate font-mono text-[11px] text-muted-foreground">{shortFingerprint(version.fingerprint)}</p></div>
                    <Badge variant={version.state === "DEMO_APPROVED" ? "success" : "secondary"}>{version.state}</Badge>
                  </div>
                  {version.state !== "RETIRED" && (
                    <Button size="sm" variant="outline" className="mt-2 w-full" disabled={action.isPending || reason.trim().length < 8} onClick={() => {
                      if (window.confirm(`Retire ${version.version}? A retired version cannot regain authority.`)) {
                        action.mutate(() => transitionAutopilotBrainVersion(version.id, { toState: "RETIRED", reason, confirmation: "RETIRE_BRAIN_VERSION" }));
                      }
                    }}>Retire {version.version}</Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
          <CardHeader><CardTitle>{mandate ? "Create a replacement Demo mandate" : "Create an immutable Demo mandate"}</CardTitle><CardDescription>Every value is pinned to the current configuration and cannot expand its deterministic limits. Existing terms are never edited.</CardDescription></CardHeader>
          <CardContent className="space-y-5">
            {config?.mode !== "autopilot" && <div className="flex gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm"><AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" /> Set this sandbox configuration to Autopilot mode in Settings before freezing a mandate. Real Live Autopilot is refused.</div>}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div><Label htmlFor="ap-position">Max position (USDT)</Label><Input id="ap-position" type="number" value={positionSize} onChange={(e) => setPositionSize(e.target.value)} /></div>
              <div><Label htmlFor="ap-loss">Daily loss limit (USDT)</Label><Input id="ap-loss" type="number" value={dailyLoss} onChange={(e) => setDailyLoss(e.target.value)} /></div>
              <div><Label htmlFor="ap-dd">Max drawdown (%)</Label><Input id="ap-dd" type="number" value={drawdown} onChange={(e) => setDrawdown(e.target.value)} /></div>
              <div><Label htmlFor="ap-age">Max market age (seconds)</Label><Input id="ap-age" type="number" value={marketAge} onChange={(e) => setMarketAge(e.target.value)} /></div>
              <div className="sm:col-span-2"><Label htmlFor="ap-expiry">Mandate expiry</Label><Input id="ap-expiry" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></div>
            </div>
            <div className="grid gap-3 rounded-lg border bg-muted/20 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><span className="text-muted-foreground">Instruments</span><p>{config?.pairs.join(", ") || "—"}</p></div>
              <div><span className="text-muted-foreground">Strategies</span><p>{enabledStrategies.map((item) => item.strategyName).join(", ") || "—"}</p></div>
              <div><span className="text-muted-foreground">Leverage</span><p>{config?.marketType === "futures" ? config.leverage : 1}x maximum</p></div>
              <div><span className="text-muted-foreground">Trading hours</span><p>All hours, still subject to existing market/session gates</p></div>
              <div><span className="text-muted-foreground">Concurrent positions</span><p>{config?.maxOpenPositions ?? "—"}</p></div>
              <div className="sm:col-span-2"><span className="text-muted-foreground">Protective actions</span><p>Hold, freeze, reduce, tighten stop, trailing, exit</p></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={action.isPending || !mandateRequest || config?.mode !== "autopilot"} onClick={() => action.mutate(() => createAutopilotMandate(mandateRequest!))}>Freeze immutable mandate</Button>
              {controlQuery.data?.mandates[0] && (controlQuery.data.mandates[0].id !== mandate?.id || control?.state !== "AUTOPILOT_ENABLED") && (
                <Button variant="outline" disabled={action.isPending || reason.trim().length < 8} onClick={() => action.mutate(() => activateAutopilot({ mandateId: controlQuery.data!.mandates[0]!.id, reason, confirmation: "ENABLE_DEMO_AUTOPILOT" }))}>Activate latest mandate</Button>
              )}
            </div>
          </CardContent>
        </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Forward soak</CardTitle><CardDescription>Persisted repository evidence only. It is never provider validation or Live promotion authority.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between"><Badge variant={soakQuery.data?.status === "AVAILABLE" ? "success" : "secondary"}>{soakQuery.data?.status ?? "LOADING"}</Badge><span className="font-mono text-xs text-muted-foreground">{shortFingerprint(soakQuery.data?.reportFingerprint)}</span></div>
            {soakQuery.data?.status === "AVAILABLE" ? <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              {[["Decisions", metrics.autonomousDecisions], ["Executed", metrics.executed], ["Refused", metrics.refused], ["Failed", metrics.failed], ["Protection", `${Number(metrics.protectionCoveragePercent ?? 0).toFixed(1)}%`], ["Realized P&L", `$${Number(metrics.realizedPnlUsdt ?? 0).toFixed(2)}`]].map(([label, value]) => <div key={String(label)} className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{String(label)}</p><p className="mt-1 font-semibold">{String(value ?? 0)}</p></div>)}
            </div> : <p className="text-sm text-muted-foreground">{soakQuery.data?.reason ?? "No active mandate evidence is available yet."}</p>}
            <p className="text-xs text-muted-foreground">Brain confidence remains uncalibrated. No Research result is silently attached.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Immutable mandate</CardTitle><CardDescription>The exact scope behind every autonomous claim and execution intent.</CardDescription></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {mandate ? <>
              <div className="grid grid-cols-2 gap-3"><div><span className="text-muted-foreground">Version</span><p>{mandate.version}</p></div><div><span className="text-muted-foreground">Expires</span><p>{new Date(mandate.expiresAt).toLocaleString()}</p></div></div>
              <div><span className="text-muted-foreground">Fingerprint</span><p className="break-all font-mono text-xs">{mandate.fingerprint}</p></div>
              <div><span className="text-muted-foreground">Markets</span><p>{mandate.instruments.join(", ")}</p></div>
              <div><span className="text-muted-foreground">Limits</span><p>${mandate.maximumPositionSizeUsdt} position · {mandate.maximumLeverage}x · {mandate.maximumConcurrentPositions} concurrent · {mandate.maximumDrawdownPercent}% drawdown</p></div>
            </> : <p className="text-muted-foreground">No mandate is selected.</p>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Clock3 className="h-4 w-4" /> Audit history</CardTitle><CardDescription>Mandates, decisions, refusals, executions, suspensions, and resumptions are append-only evidence.</CardDescription></CardHeader>
        <CardContent>
          <div className="space-y-3">
            {events.length === 0 ? <p className="text-sm text-muted-foreground">No audit events yet.</p> : events.slice(0, 50).map((event, index) => (
              <div key={event.id ?? index} className="grid gap-1 border-b pb-3 text-sm last:border-0 sm:grid-cols-[190px_1fr]">
                <div><p className="font-medium">{event.eventType ?? "AUTOPILOT_EVENT"}</p><p className="text-xs text-muted-foreground">{event.occurredAt ? new Date(event.occurredAt).toLocaleString() : "—"}</p></div>
                <div><p>{event.reason ?? "—"}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{event.reasonCode ?? "—"} · {shortFingerprint(event.fingerprint)}</p></div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

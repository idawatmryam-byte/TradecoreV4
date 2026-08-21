import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetExecutionHealthQueryKey,
  useApplyExecutionIntentAction,
  useGetExecutionHealth,
  useSetExecutionOperatingMode,
  type ResolveExecutionIntentBodyAction,
  type SetExecutionOperatingModeBodyAction,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  Ban,
  RefreshCw,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { PageHeader } from "@/components/patterns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/use-toast";

type SafetyAction = SetExecutionOperatingModeBodyAction;
type IntentAction = ResolveExecutionIntentBodyAction;

const ACTION_COPY: Record<
  SafetyAction,
  { title: string; phrase: string; description: string }
> = {
  STOP_NEW_TRADES: {
    title: "Stop new Live trades",
    phrase: "STOP NEW TRADES",
    description:
      "Blocks new entries for this market section. Existing positions remain open and protective management and exits remain enabled.",
  },
  EXIT_ONLY: {
    title: "Enter exit-only mode",
    phrase: "EXIT ONLY",
    description:
      "Blocks all entry authority for this market section while preserving position reduction, protection, and exits.",
  },
};

function errorMessage(error: unknown): string {
  const data = (error as { data?: { error?: unknown } | null })?.data;
  return typeof data?.error === "string"
    ? data.error
    : error instanceof Error
      ? error.message
      : "The safety action was refused";
}

function timestamp(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

function StateBadge({ value }: { value: string }) {
  const variant =
    value === "HEALTHY" || value === "NORMAL"
      ? "success"
      : value === "UNKNOWN" || value === "INCOMPLETE"
        ? "warning"
        : "destructive";
  return <Badge variant={variant}>{value.replaceAll("_", " ")}</Badge>;
}

function SafetyActionDialog({
  action,
  open,
  pending,
  onOpenChange,
  onConfirm,
}: {
  action: SafetyAction;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: {
    confirmation: string;
    reason: string;
    password: string;
  }) => void;
}) {
  const copy = ACTION_COPY[action];
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const valid = confirmation === copy.phrase && reason.trim().length >= 8;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldX className="h-5 w-5 text-destructive" /> {copy.title}
          </AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="execution-health-reason">Operator reason</Label>
            <Textarea
              id="execution-health-reason"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why this authority reduction is required"
              className="mt-2"
            />
          </div>
          <div>
            <Label htmlFor="execution-health-password">Current password</Label>
            <Input
              id="execution-health-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2"
            />
          </div>
          <div>
            <Label htmlFor="execution-health-confirmation">
              Type <span className="font-mono">{copy.phrase}</span>
            </Label>
            <Input
              id="execution-health-confirmation"
              value={confirmation}
              autoComplete="off"
              onChange={(event) => setConfirmation(event.target.value)}
              className="mt-2 font-mono"
            />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!valid || pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              if (valid)
                onConfirm({ confirmation, reason: reason.trim(), password });
            }}
          >
            {pending ? "Applying…" : copy.title}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function IntentActionDialog({
  action,
  open,
  pending,
  onOpenChange,
  onConfirm,
}: {
  action: IntentAction;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: {
    confirmation: string;
    reason: string;
    password: string;
  }) => void;
}) {
  const phrase =
    action === "RETRY_RECOVERY" ? "RETRY RECOVERY" : "ACKNOWLEDGE BLOCKED";
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const valid = confirmation === phrase && reason.trim().length >= 8;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Evidence-backed reconciliation action
          </AlertDialogTitle>
          <AlertDialogDescription>
            {action === "RETRY_RECOVERY"
              ? "Reopens provider reconciliation. It does not claim the exposure is safe or resolved."
              : "Records operator awareness while the intent and Live entry boundary remain blocked."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="intent-action-reason">Operator reason</Label>
            <Textarea
              id="intent-action-reason"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              className="mt-2"
            />
          </div>
          <div>
            <Label htmlFor="intent-action-password">Current password</Label>
            <Input
              id="intent-action-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2"
            />
          </div>
          <div>
            <Label htmlFor="intent-action-confirmation">
              Type <span className="font-mono">{phrase}</span>
            </Label>
            <Input
              id="intent-action-confirmation"
              value={confirmation}
              autoComplete="off"
              onChange={(event) => setConfirmation(event.target.value)}
              className="mt-2 font-mono"
            />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!valid || pending}
            onClick={(event) => {
              event.preventDefault();
              if (valid)
                onConfirm({ confirmation, reason: reason.trim(), password });
            }}
          >
            {pending ? "Recording…" : phrase}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ExecutionHealthPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [action, setAction] = useState<SafetyAction | null>(null);
  const [intentAction, setIntentAction] = useState<{
    intentId: number;
    action: IntentAction;
  } | null>(null);
  const health = useGetExecutionHealth({
    query: {
      queryKey: getGetExecutionHealthQueryKey(),
      refetchInterval: 5_000,
    },
  });
  const control = useSetExecutionOperatingMode({
    mutation: {
      onSuccess: async () => {
        setAction(null);
        await queryClient.invalidateQueries({
          queryKey: getGetExecutionHealthQueryKey(),
        });
        toast({
          title: "Live authority reduced",
          description:
            "The durable operating mode was updated. Existing-position exits remain enabled.",
        });
      },
      onError: (error) =>
        toast({
          title: "Safety action refused",
          description: errorMessage(error),
          variant: "destructive",
        }),
    },
  });
  const intentControl = useApplyExecutionIntentAction({
    mutation: {
      onSuccess: async () => {
        setIntentAction(null);
        await queryClient.invalidateQueries({
          queryKey: getGetExecutionHealthQueryKey(),
        });
        toast({
          title: "Reconciliation action recorded",
          description:
            "The action is auditable. Live entry remains blocked until authoritative reconciliation is healthy.",
        });
      },
      onError: (error) =>
        toast({
          title: "Reconciliation action refused",
          description: errorMessage(error),
          variant: "destructive",
        }),
    },
  });

  if (health.isLoading) {
    return (
      <div
        className="flex min-h-[45vh] items-center justify-center gap-3 text-muted-foreground"
        role="status"
      >
        <RefreshCw className="h-5 w-5 animate-spin" /> Loading authoritative
        execution health…
      </div>
    );
  }

  if (health.isError || !health.data) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={ShieldCheck}
          title="Execution Health"
          description="Live execution safety and reconciliation truth."
        />
        <Card className="border-destructive/60">
          <CardContent className="flex items-start gap-3 p-6">
            <ShieldX className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="font-semibold">Execution health unavailable</p>
              <p className="mt-1 text-sm text-muted-foreground">
                The dashboard cannot establish current safety state. Treat Live
                entry authority as unknown and blocked.
              </p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => void health.refetch()}
              >
                Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const data = health.data;
  const blocked = data.status !== "HEALTHY";

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ShieldCheck}
        title="Execution Health"
        description="Durable Live execution state, reconciliation, protection, drawdown, ownership, and unresolved broker intent truth."
        actions={
          <Button
            variant="outline"
            onClick={() => void health.refetch()}
            disabled={health.isFetching}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${health.isFetching ? "animate-spin" : ""}`}
            />{" "}
            Refresh
          </Button>
        }
      />

      <div
        role="status"
        className={`rounded-xl border-2 p-4 ${
          blocked
            ? "border-destructive/60 bg-destructive/10"
            : "border-success/60 bg-success/10"
        }`}
      >
        <div className="flex items-start gap-3">
          {blocked ? (
            <ShieldX className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          ) : (
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          )}
          <div>
            <p className="font-semibold">
              LIVE ENTRY AUTHORITY · {data.status}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {data.entryBlockReason ??
                (blocked
                  ? "One or more required safety signals are not healthy. Unknown does not mean zero or safe."
                  : "All persisted entry gates currently report healthy.")}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Engine stopped does not mean positions are closed. This page never
              presents simulated state as broker execution.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Operating mode", data.operatingMode],
          ["Reconciliation", data.reconciliationState],
          ["Protection", data.protectionState],
          ["Account drawdown", data.accountDrawdownState],
          ["Global drawdown", data.globalDrawdownState],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {label}
              </p>
              <div className="mt-2">
                <StateBadge value={value} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Runtime and ownership</CardTitle>
            <CardDescription>
              Process state is shown separately from durable safety state.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Engine</span>
              <p>{data.runtime.running ? "Running" : "Stopped"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">New entries</span>
              <p>
                {data.runtime.newEntriesAllowed
                  ? "Runtime allows"
                  : "Runtime blocked"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Open positions</span>
              <p className="tabular-nums">{data.runtime.openPositions}</p>
            </div>
            <div>
              <span className="text-muted-foreground">
                Ownership generation
              </span>
              <p className="tabular-nums">{data.ownershipGeneration}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Owner claimed</span>
              <p>{timestamp(data.ownerClaimedAt)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Last reconciliation</span>
              <p>{timestamp(data.lastReconciledAt)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Last scan</span>
              <p>{timestamp(data.runtime.lastScanAt)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Last incident</span>
              <p>{timestamp(data.lastIncidentAt)}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Drawdown evidence</CardTitle>
            <CardDescription>
              Exact persisted minor units; unavailable values remain
              unavailable.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">
                Current equity (minor units)
              </span>
              <p className="font-mono">
                {data.currentEquityMinor ?? "UNKNOWN"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">
                Peak equity (minor units)
              </span>
              <p className="font-mono">{data.peakEquityMinor ?? "UNKNOWN"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Account source</span>
              <p>{data.equitySource ?? "UNKNOWN"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Account freshness</span>
              <p>{timestamp(data.equityFreshUntil)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">
                Global current / peak
              </span>
              <p className="font-mono">
                {data.globalCurrentEquityMinor ?? "UNKNOWN"} /{" "}
                {data.globalPeakEquityMinor ?? "UNKNOWN"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Global freshness</span>
              <p>{timestamp(data.globalEquityFreshUntil)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Global sources</span>
              <p className="tabular-nums">{data.globalEquitySourceCount}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Account limit</span>
              <p className="tabular-nums">
                {(data.accountDrawdownLimitBps / 100).toFixed(2)}%
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Global limit</span>
              <p className="tabular-nums">
                {(data.globalDrawdownLimitBps / 100).toFixed(2)}%
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Emergency authority reduction</CardTitle>
          <CardDescription>
            These controls only reduce authority and never imply that a position
            is closed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            onClick={() => setAction("STOP_NEW_TRADES")}
          >
            <Ban className="mr-2 h-4 w-4" /> Stop new trades
          </Button>
          <Button variant="destructive" onClick={() => setAction("EXIT_ONLY")}>
            <ShieldX className="mr-2 h-4 w-4" /> Exit-only mode
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Safety metrics</CardTitle>
          <CardDescription>
            Current unresolved state plus counts from the latest 100 durable
            incident events.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
          {[
            ["Unresolved intents", data.metrics.unresolvedIntents],
            ["Reconciliation failures", data.metrics.reconciliationFailures],
            ["Recovered exposure", data.metrics.recoveredExposure],
            ["Protection failures", data.metrics.protectionFailures],
            ["Active switches", data.metrics.activeKillSwitches],
            ["Mode changes", data.metrics.operatingModeChanges],
            ["Drawdown breaches", data.metrics.drawdownBreaches],
            ["Ownership changes", data.metrics.ownershipChanges],
            ["Critical alerts", data.metrics.criticalAlerts],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg border p-3">
              <p className="text-muted-foreground">{label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Active kill switches</CardTitle>
            <CardDescription>
              Applicable platform and user safety scopes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.activeSwitches.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No applicable active kill switch is recorded.
              </p>
            ) : (
              <div className="space-y-3">
                {data.activeSwitches.map((item) => (
                  <div
                    key={`${item.scope}:${item.scopeKey}:${item.activatedAt}`}
                    className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="destructive">{item.scope}</Badge>
                      <span className="font-mono text-xs">{item.scopeKey}</span>
                      <Badge variant="outline">{item.source}</Badge>
                    </div>
                    <p className="mt-2 text-sm">{item.reason}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Activated {timestamp(item.activatedAt)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Unresolved execution intents</CardTitle>
            <CardDescription>
              Submission, fill, or reconciliation states that are not terminally
              safe.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.unresolvedIntents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No unresolved durable intent is recorded.
              </p>
            ) : (
              <div className="space-y-3">
                {data.unresolvedIntents.map((intent) => (
                  <div
                    key={intent.id}
                    className="rounded-lg border border-warning/40 bg-warning/5 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <span className="font-medium">{intent.symbol}</span>
                      <Badge variant="warning">{intent.state}</Badge>
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      {intent.clientOrderId}
                    </p>
                    <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <span>
                        Resolution: {intent.resolutionCode ?? "UNKNOWN"}
                      </span>
                      <span>Filled: {intent.filledQuantity ?? "UNKNOWN"}</span>
                      <span>
                        Average price: {intent.averageFillPrice ?? "UNKNOWN"}
                      </span>
                      <span>
                        Reconciled: {timestamp(intent.lastReconciledAt)}
                      </span>
                      <span>
                        Recovery: {intent.recoveryState ?? "UNAVAILABLE"}
                      </span>
                      <span>
                        Recovery attempted:{" "}
                        {timestamp(intent.recoveryAttemptedAt)}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setIntentAction({
                            intentId: intent.id,
                            action: "RETRY_RECOVERY",
                          })
                        }
                      >
                        Retry recovery
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setIntentAction({
                            intentId: intent.id,
                            action: "ACKNOWLEDGE_BLOCKED",
                          })
                        }
                      >
                        Acknowledge blocked
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Incident and resolution history</CardTitle>
          <CardDescription>
            Durable, user-scoped safety events. Acknowledgement records operator
            awareness but never converts uncertainty into a resolved state.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.incidents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No durable safety incident is recorded for this section.
            </p>
          ) : (
            <div className="space-y-3">
              {data.incidents.map((incident) => (
                <div key={incident.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        incident.eventType === "CRITICAL_OPERATOR_ALERT"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {incident.eventType.replaceAll("_", " ")}
                    </Badge>
                    <Badge variant="outline">{incident.source}</Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {incident.reasonCode}
                    </span>
                  </div>
                  <p className="mt-2 text-sm">{incident.reason}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {incident.actorType} · {timestamp(incident.occurredAt)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {action && (
        <SafetyActionDialog
          key={action}
          action={action}
          open
          pending={control.isPending}
          onOpenChange={(open) => {
            if (!open && !control.isPending) setAction(null);
          }}
          onConfirm={(input) => control.mutate({ data: { action, ...input } })}
        />
      )}
      {intentAction && (
        <IntentActionDialog
          key={`${intentAction.intentId}:${intentAction.action}`}
          action={intentAction.action}
          open
          pending={intentControl.isPending}
          onOpenChange={(open) => {
            if (!open && !intentControl.isPending) setIntentAction(null);
          }}
          onConfirm={(input) =>
            intentControl.mutate({
              intentId: intentAction.intentId,
              data: {
                action: intentAction.action,
                ...input,
                ownershipGeneration: data.ownershipGeneration,
                idempotencyKey: crypto.randomUUID(),
              },
            })
          }
        />
      )}
    </div>
  );
}

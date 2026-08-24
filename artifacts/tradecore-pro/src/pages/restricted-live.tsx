import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  approveTradingMandate,
  createTradingMandate,
  getGetTradingMandateControlQueryKey,
  revokeTradingMandate,
  submitTradingMandate,
  suspendTradingMandate,
  useGetAutopilotControl,
  useGetConfig,
  useGetTradingMandateControl,
  type AutopilotControlCenter,
  type AutopilotMandate,
  type CreateTradingMandateRequest,
  type TradingMandate,
  type TradingMandateTerms,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  Clock3,
  GitCompareArrows,
  KeyRound,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
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
import { PageHeader } from "@/components/patterns";
import { useToast } from "@/components/ui/use-toast";

const SCALE = 100_000_000;

function atomic(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error("Financial limits must be positive numbers");
  return BigInt(Math.ceil(parsed * SCALE)).toString();
}

function money(value?: string | null): string {
  if (value == null) return "Unavailable";
  const whole = BigInt(value) / BigInt(SCALE);
  const fraction = (BigInt(value) % BigInt(SCALE))
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return `$${whole.toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}

function message(error: unknown): string {
  const body = (error as { data?: { error?: unknown } })?.data;
  return typeof body?.error === "string"
    ? body.error
    : error instanceof Error
      ? error.message
      : "The safety action was refused";
}

function short(value?: string | null): string {
  return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—";
}

function requestId(): string {
  return crypto.randomUUID();
}

function termsSummary(mandate: TradingMandate) {
  const terms = mandate.terms;
  return [
    ["Brain", `${terms.brainVersion} · ${short(terms.brainFingerprint)}`],
    [
      "Accounts / venues",
      `${terms.accountIds.map(short).join(", ")} · ${terms.exchanges.join(", ")}`,
    ],
    ["Symbols", terms.symbols.join(", ")],
    ["Strategies", Object.keys(terms.strategies).join(", ")],
    [
      "Per trade / position",
      `${money(terms.maximumPerTradeRisk)} risk · ${money(terms.maximumPositionNotional)} notional`,
    ],
    [
      "Aggregate / canary",
      `${money(terms.maximumAggregateExposure)} · ${money(terms.canaryAllocation)}`,
    ],
    ["Leverage", `${(terms.maximumLeverageBps / 10_000).toFixed(2)}x`],
    [
      "Loss limits",
      `${money(terms.dailyLossLimit)} daily · ${money(terms.weeklyLossLimit)} weekly · ${money(terms.monthlyLossLimit)} monthly`,
    ],
    ["Drawdown", `${(terms.maximumDrawdownBps / 100).toFixed(2)}%`],
    [
      "Hours",
      terms.tradingHours
        .map(
          (window) =>
            `${window.daysOfWeek.join("/")} ${String(Math.floor(window.startMinute / 60)).padStart(2, "0")}:${String(window.startMinute % 60).padStart(2, "0")}–${String(Math.floor(window.endMinute / 60)).padStart(2, "0")}:${String(window.endMinute % 60).padStart(2, "0")} ${window.timezone}`,
        )
        .join("; "),
    ],
    [
      "Effective / expiry",
      `${new Date(terms.effectiveAt).toLocaleString()} → ${new Date(terms.expiresAt).toLocaleString()}`,
    ],
    [
      "Outside scope",
      terms.fallbackPolicy === "COPILOT_VALID_ONLY"
        ? "Labeled Co-Pilot proposal, valid scope refusals only"
        : "Abstain",
    ],
  ];
}

function selectCurrentDemoMandate(
  control: AutopilotControlCenter | undefined,
  now = Date.now(),
): AutopilotMandate | null {
  if (!control) return null;
  const snapshot = control.snapshot as {
    control?: { mandateId?: unknown };
    mandateState?: { mandateId?: unknown; state?: unknown } | null;
    brainVersion?: { id?: unknown; state?: unknown } | null;
  };
  const mandateId = snapshot.control?.mandateId;
  if (
    typeof mandateId !== "number" ||
    snapshot.mandateState?.mandateId !== mandateId ||
    snapshot.mandateState.state !== "ACTIVE"
  ) {
    return null;
  }
  const candidates = control.mandates.filter(
    (mandate) =>
      mandate.id === mandateId &&
      mandate.brainVersionId === snapshot.brainVersion?.id &&
      ["DEMO_APPROVED", "LIVE_RESTRICTED"].includes(
        String(snapshot.brainVersion?.state),
      ) &&
      Date.parse(mandate.validFrom) <= now &&
      now < Date.parse(mandate.expiresAt),
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

export function RestrictedLivePage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const controlQuery = useGetTradingMandateControl({
    query: {
      queryKey: getGetTradingMandateControlQueryKey(),
      refetchInterval: 10_000,
    },
  });
  const brainQuery = useGetAutopilotControl();
  const configQuery = useGetConfig();
  const control = controlQuery.data;
  const active = control?.activeMandate ?? null;
  const latest = control?.mandates[0] ?? null;
  const controlled =
    active ?? (latest?.lifecycleState === "SUSPENDED" ? latest : null);
  const demoMandate = selectCurrentDemoMandate(brainQuery.data);
  const brain = demoMandate
    ? brainQuery.data?.versions.find(
        (item) =>
          item.id === demoMandate.brainVersionId &&
          item.version === demoMandate.brainVersion &&
          ["DEMO_APPROVED", "LIVE_RESTRICTED"].includes(item.state),
      )
    : undefined;
  const config = configQuery.data;

  const [reason, setReason] = useState(
    "Operator reviewed the immutable Restricted Live financial authority",
  );
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState("");
  const [perTradeRisk, setPerTradeRisk] = useState("10");
  const [positionNotional, setPositionNotional] = useState("100");
  const [aggregateExposure, setAggregateExposure] = useState("250");
  const [canary, setCanary] = useState("100");
  const [dailyLoss, setDailyLoss] = useState("25");
  const [weeklyLoss, setWeeklyLoss] = useState("75");
  const [monthlyLoss, setMonthlyLoss] = useState("150");
  const [drawdown, setDrawdown] = useState("5");

  useEffect(() => {
    if (!expiry)
      setExpiry(
        new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16),
      );
    if (config) {
      setPositionNotional((current) =>
        current === "100" ? String(config.positionSizeUsdt) : current,
      );
      setDailyLoss((current) =>
        current === "25" ? String(config.dailyLossLimitUsdt) : current,
      );
    }
  }, [config, expiry]);

  const refresh = async () =>
    queryClient.invalidateQueries({
      queryKey: getGetTradingMandateControlQueryKey(),
    });
  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      await refresh();
      setPassword("");
      toast({
        title: "Restricted Live control updated",
        description: "Server authority and append-only audit were refreshed.",
      });
    },
    onError: (error) =>
      toast({
        title: "Financial authority refused",
        description: message(error),
        variant: "destructive",
      }),
  });

  const builder = useMemo<CreateTradingMandateRequest | null>(() => {
    if (
      !brain ||
      !config ||
      !demoMandate ||
      !control?.eligibleAccounts[0] ||
      !expiry
    )
      return null;
    const authority =
      config.marketType === "forex"
        ? "oanda_live"
        : config.marketType === "futures"
          ? "binance_futures_live"
          : "binance_spot_live";
    const terms: TradingMandateTerms = {
      brainVersionId: brain.id,
      brainVersion: brain.version,
      brainFingerprint: brain.fingerprint,
      accountIds: [control.eligibleAccounts[0].accountId],
      exchanges: [authority],
      markets: [config.marketType],
      symbols: demoMandate.instruments,
      strategies: demoMandate.strategyVersions,
      models: [brain.implementation],
      settlementCurrency: config.marketType === "forex" ? "USD" : "USDT",
      monetaryScale: 8,
      maximumPerTradeRisk: atomic(perTradeRisk),
      maximumPositionNotional: atomic(positionNotional),
      maximumAggregateExposure: atomic(aggregateExposure),
      maximumLeverageBps: Math.ceil(Math.max(1, config.leverage) * 10_000),
      maximumConcurrentPositions: config.maxOpenPositions,
      maximumConcurrentOrders: Math.max(config.maxOpenPositions * 3, 1),
      dailyLossLimit: atomic(dailyLoss),
      weeklyLossLimit: atomic(weeklyLoss),
      monthlyLossLimit: atomic(monthlyLoss),
      maximumDrawdownBps: Math.ceil(Number(drawdown) * 100),
      tradingHours: [
        {
          timezone: "UTC",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          startMinute: 0,
          endMinute: 1440,
        },
      ],
      effectiveAt: new Date().toISOString(),
      expiresAt: new Date(expiry).toISOString(),
      canaryAllocation: atomic(canary),
      automaticSuspension: {
        maximumSpreadBps: 50,
        maximumSlippageBps: 35,
        maximumFillLatencyMs: 5_000,
        maximumProtectionFailures: 0,
        maximumReconciliationAgeSeconds: 60,
        maximumDecisionRatePerHour: 60,
        maximumEntryRatePerHour: 6,
        maximumLiveDemoDivergenceBps: 50,
        maximumMarketDataAgeSeconds: 30,
      },
      fallbackPolicy: "COPILOT_VALID_ONLY",
    };
    return {
      clientRequestId: requestId(),
      expectedNextRevision: (latest?.revision ?? 0) + 1,
      replacesMandateId: latest?.id ?? null,
      changeReason: reason,
      terms,
    };
  }, [
    aggregateExposure,
    brain,
    canary,
    config,
    control?.eligibleAccounts,
    dailyLoss,
    demoMandate,
    drawdown,
    expiry,
    latest?.id,
    latest?.revision,
    monthlyLoss,
    perTradeRisk,
    positionNotional,
    reason,
    weeklyLoss,
  ]);

  const maximumExposure = builder
    ? [
        BigInt(builder.terms.maximumAggregateExposure),
        BigInt(builder.terms.canaryAllocation),
        BigInt(builder.terms.maximumPositionNotional) *
          BigInt(builder.terms.maximumConcurrentPositions),
      ]
        .reduce((a, b) => (a < b ? a : b))
        .toString()
    : null;
  const canMutate =
    control?.role === "OWNER" || control?.role === "FINANCIAL_OPERATOR";
  const state =
    active?.lifecycleState ?? latest?.lifecycleState ?? "NO_MANDATE";

  if (controlQuery.isLoading)
    return (
      <div className="p-8" role="status">
        Loading Restricted Live authority…
      </div>
    );
  if (controlQuery.isError)
    return (
      <div className="rounded-lg border border-destructive p-6" role="alert">
        <h1 className="font-semibold">Restricted Live unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {message(controlQuery.error)}
        </p>
        <Button className="mt-4" onClick={() => controlQuery.refetch()}>
          Retry
        </Button>
      </div>
    );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ShieldCheck}
        title="Restricted Live"
        description="Immutable, revocable human authority for one exact brain version. This screen never sends broker orders."
      />

      <div
        className="rounded-xl border-2 border-amber-500/60 bg-amber-500/10 p-4"
        role="status"
      >
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-semibold">
              REAL-MONEY CAPABLE · EXPLICIT ACTIVATION REQUIRED
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              A mandate is an additional gate. Phase 11 safety, deterministic
              risk, durable intent, reconciliation, protection, and kill
              switches remain mandatory. Exit and protection authority survives
              entry suspension.
            </p>
          </div>
        </div>
      </div>

      {(control?.degradedReasons.length ?? 0) > 0 && (
        <div
          className="rounded-lg border border-destructive/50 bg-destructive/10 p-4"
          role="alert"
        >
          <p className="font-medium">
            Entry authority is degraded and fails closed
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {control?.degradedReasons.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {!canMutate && (
        <div className="rounded-lg border p-4" role="note">
          <p className="font-medium">View-only access</p>
          <p className="text-sm text-muted-foreground">
            An Owner or Financial Operator must create and authorize mandates.
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Current authority</CardTitle>
                <CardDescription>
                  Persistent lifecycle state and server-calculated capacity.
                </CardDescription>
              </div>
              <Badge
                variant={
                  state === "ACTIVE"
                    ? "success"
                    : state === "SUSPENDED"
                      ? "warning"
                      : "destructive"
                }
              >
                {state}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {active ? (
              <div className="grid gap-3 text-sm sm:grid-cols-2">
                {termsSummary(active).map(([label, value]) => (
                  <div key={label} className="rounded-lg border p-3">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      {label}
                    </span>
                    <p className="mt-1 break-words">{value}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No active mandate. Autonomous Live entry has no authority.
              </p>
            )}
            <div className="grid gap-3 rounded-lg border bg-muted/20 p-4 text-sm sm:grid-cols-3">
              <div>
                <span className="text-muted-foreground">Usage freshness</span>
                <p>{control?.usage?.status ?? "UNAVAILABLE"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">
                  Exposure / remaining
                </span>
                <p>
                  {money(control?.usage?.aggregateExposure)} /{" "}
                  {money(control?.usage?.remainingExposure)}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">
                  Canary used / remaining
                </span>
                <p>
                  {money(control?.usage?.canaryUsed)} /{" "}
                  {money(control?.usage?.canaryRemaining)}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">
                  Positions / orders
                </span>
                <p>
                  {control?.usage?.openPositionCount ?? "—"} /{" "}
                  {control?.usage?.openOrderCount ?? "—"}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Loss D / W / M</span>
                <p>
                  {money(control?.usage?.dailyLoss)} /{" "}
                  {money(control?.usage?.weeklyLoss)} /{" "}
                  {money(control?.usage?.monthlyLoss)}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Drawdown</span>
                <p>
                  {control?.usage?.drawdownBps == null
                    ? "Unavailable"
                    : `${(control.usage.drawdownBps / 100).toFixed(2)}%`}
                </p>
              </div>
            </div>
            {controlled && canMutate && (
              <div className="flex flex-wrap gap-2">
                {controlled.lifecycleState === "ACTIVE" && (
                  <Button
                    variant="outline"
                    disabled={action.isPending || reason.length < 12}
                    onClick={() =>
                      action.mutate(() =>
                        suspendTradingMandate(controlled.id, {
                          clientRequestId: requestId(),
                          expectedRevision: controlled.revision,
                          reason,
                        }),
                      )
                    }
                  >
                    <ShieldX className="mr-2 h-4 w-4" />
                    Suspend entries
                  </Button>
                )}
                <Button
                  variant="destructive"
                  disabled={action.isPending || reason.length < 12}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Permanently revoke this mandate? New entries stop; protective exits remain authorized.",
                      )
                    )
                      action.mutate(() =>
                        revokeTradingMandate(controlled.id, {
                          clientRequestId: requestId(),
                          expectedRevision: controlled.revision,
                          reason,
                        }),
                      );
                  }}
                >
                  <ShieldX className="mr-2 h-4 w-4" />
                  Revoke permanently
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Authorization</CardTitle>
            <CardDescription>
              Approval is role-checked, session-bound, replay-resistant step-up.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <span className="text-muted-foreground">Role</span>
              <p>{control?.role ?? "unavailable"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Approved by</span>
              <p>
                {active?.approvingHumanId
                  ? `User ${active.approvingHumanId}`
                  : "No approval"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Authorized at</span>
              <p>
                {active?.authorizedAt
                  ? new Date(active.authorizedAt).toLocaleString()
                  : "—"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Fingerprint</span>
              <p className="break-all font-mono text-xs">
                {active?.fingerprint ?? "—"}
              </p>
            </div>
            <div>
              <Label htmlFor="mandate-reason">Operator reason</Label>
              <Textarea
                id="mandate-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="mt-2"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {latest ? "Create replacement revision" : "Build mandate draft"}
          </CardTitle>
          <CardDescription>
            Approved terms are never edited. Any renewal, expansion, risk
            increase, account, symbol, strategy, or brain change creates a new
            immutable revision.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!demoMandate && (
            <div
              className="rounded-lg border border-destructive/50 p-3 text-sm"
              role="alert"
            >
              An exact Demo-approved mandate is required to pin current strategy
              versions before Restricted Live can be drafted.
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label htmlFor="rl-risk">Max risk / trade</Label>
              <Input
                id="rl-risk"
                inputMode="decimal"
                value={perTradeRisk}
                onChange={(e) => setPerTradeRisk(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="rl-position">Max position notional</Label>
              <Input
                id="rl-position"
                inputMode="decimal"
                value={positionNotional}
                onChange={(e) => setPositionNotional(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="rl-exposure">Max aggregate exposure</Label>
              <Input
                id="rl-exposure"
                inputMode="decimal"
                value={aggregateExposure}
                onChange={(e) => setAggregateExposure(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="rl-canary">Canary allocation</Label>
              <Input
                id="rl-canary"
                inputMode="decimal"
                value={canary}
                onChange={(e) => setCanary(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="rl-daily">Daily loss</Label>
              <Input
                id="rl-daily"
                value={dailyLoss}
                onChange={(e) => setDailyLoss(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="rl-weekly">Weekly loss</Label>
              <Input
                id="rl-weekly"
                value={weeklyLoss}
                onChange={(e) => setWeeklyLoss(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="rl-monthly">Monthly loss</Label>
              <Input
                id="rl-monthly"
                value={monthlyLoss}
                onChange={(e) => setMonthlyLoss(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="rl-dd">Max drawdown (%)</Label>
              <Input
                id="rl-dd"
                value={drawdown}
                onChange={(e) => setDrawdown(e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="rl-expiry">Hard expiry (maximum 30 days)</Label>
              <Input
                id="rl-expiry"
                type="datetime-local"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </div>
          </div>
          <div className="rounded-lg border bg-muted/20 p-4 text-sm">
            <p className="font-medium">Maximum possible financial exposure</p>
            <p className="mt-1 text-2xl font-semibold">
              {money(maximumExposure)}
            </p>
            <p className="mt-1 text-muted-foreground">
              The server enforces the minimum of aggregate exposure, canary
              allocation, and position-notional × concurrent-position limits.
              Current usage is subtracted again at entry.
            </p>
          </div>
          <Button
            disabled={
              !builder || !canMutate || action.isPending || reason.length < 12
            }
            onClick={() =>
              builder &&
              action.mutate(() =>
                createTradingMandate({
                  ...builder,
                  clientRequestId: requestId(),
                }),
              )
            }
          >
            Create immutable draft
          </Button>
        </CardContent>
      </Card>

      {latest && latest.lifecycleState === "DRAFT" && (
        <Card>
          <CardHeader>
            <CardTitle>Submit for approval</CardTitle>
            <CardDescription>
              Submission freezes the draft fingerprint; it still has no
              execution authority.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              disabled={!canMutate || action.isPending || reason.length < 12}
              onClick={() =>
                action.mutate(() =>
                  submitTradingMandate(latest.id, {
                    clientRequestId: requestId(),
                    expectedRevision: latest.revision,
                    reason,
                  }),
                )
              }
            >
              Submit exact revision
            </Button>
          </CardContent>
        </Card>
      )}
      {latest && latest.lifecycleState === "PENDING_APPROVAL" && (
        <Card>
          <CardHeader>
            <CardTitle>Step-up authorization</CardTitle>
            <CardDescription>
              Approves only this revision and fingerprint. Passwords are sent
              only to the step-up endpoint and never returned or audited.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-md">
              <Label htmlFor="rl-password">Current password</Label>
              <Input
                id="rl-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-2"
              />
            </div>
            <Button
              disabled={!canMutate || action.isPending || reason.length < 12}
              onClick={() =>
                action.mutate(() =>
                  approveTradingMandate(latest.id, {
                    clientRequestId: requestId(),
                    authorizationId: crypto.randomUUID(),
                    expectedRevision: latest.revision,
                    reason,
                    confirmation: "AUTHORIZE_RESTRICTED_LIVE_MANDATE",
                    ...(password && { currentPassword: password }),
                  }),
                )
              }
            >
              <KeyRound className="mr-2 h-4 w-4" />
              Authorize exact revision
            </Button>
          </CardContent>
        </Card>
      )}

      {latest?.replacesMandateId && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitCompareArrows className="h-5 w-5" />
              Old versus new
            </CardTitle>
            <CardDescription>
              Revision {latest.revision} replaces mandate{" "}
              {latest.replacesMandateId}. Changed authority always requires
              fresh step-up.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="p-2">Term</th>
                  <th className="p-2">New revision</th>
                </tr>
              </thead>
              <tbody>
                {termsSummary(latest).map(([label, value]) => (
                  <tr className="border-b" key={label}>
                    <th className="p-2 font-medium">{label}</th>
                    <td className="p-2">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Lifecycle audit</CardTitle>
            <CardDescription>
              Append-only activation, replacement, suspension, expiry,
              revocation, and authorization evidence.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {control?.events.length ? (
                control.events.map((event) => (
                  <div key={event.id} className="rounded-lg border p-3 text-sm">
                    <div className="flex justify-between gap-3">
                      <p className="font-medium">{event.eventType}</p>
                      <time className="text-xs text-muted-foreground">
                        {new Date(event.occurredAt).toLocaleString()}
                      </time>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      {event.reasonCode} · {event.reason}
                    </p>
                    <p className="mt-1 font-mono text-xs">
                      {event.fromState ?? "—"} → {event.toState ?? "—"}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  No lifecycle events.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent autonomous decisions</CardTitle>
            <CardDescription>
              Claims, boundary authorization, executions, refusals, failures,
              and unknown broker outcomes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {control?.decisions.length ? (
                control.decisions.map((decision) => (
                  <div
                    key={decision.id}
                    className="rounded-lg border p-3 text-sm"
                  >
                    <div className="flex justify-between gap-3">
                      <Badge
                        variant={
                          decision.status === "EXECUTED"
                            ? "success"
                            : decision.status === "OUTCOME_UNKNOWN"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {decision.status}
                      </Badge>
                      <time className="text-xs text-muted-foreground">
                        {new Date(decision.createdAt).toLocaleString()}
                      </time>
                    </div>
                    <p className="mt-2">{decision.reasonCode}</p>
                    <p className="text-muted-foreground">{decision.reason}</p>
                    <p className="mt-1 font-mono text-xs">
                      decision {short(decision.decisionFingerprint)} · intent{" "}
                      {decision.intentId ?? "none"} · trade{" "}
                      {decision.tradeId ?? "none"}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  No autonomous Restricted Live decisions.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Clock3 className="h-4 w-4" />
        All limits are server-authoritative. Missing or stale usage, provider
        health, protection, reconciliation, market data, or identity evidence
        blocks new entry.
      </p>
    </div>
  );
}

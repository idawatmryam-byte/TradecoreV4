import { useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  CircleGauge,
  Clock3,
  ShieldAlert,
  WalletCards,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DashboardSession, MetricValue } from "@/lib/cactus-api";
import { cn } from "@/lib/utils";

export function formatTradingNumber(value: number): string {
  if (!Number.isFinite(value)) return "Unavailable";
  return new Intl.NumberFormat(undefined, {
    maximumSignificantDigits: 7,
  }).format(value);
}

export function managementLabel(authority: string | null): string {
  if (authority === "phase7") return "Thesis managed";
  if (authority === "fixed") return "Fixed rules";
  return authority ? authority.replaceAll("_", " ") : "Unverified";
}

export function operatingStatus(session: DashboardSession) {
  const mode = session.context.mode.configured;
  const positionCount = session.runtime.openPositionCount;
  const positions = `${positionCount} open position${positionCount === 1 ? "" : "s"}`;
  if (!session.runtime.running)
    return {
      title: "Runtime stopped",
      detail: `${positions}. Start the runtime to resume scanning and automated management.`,
      active: false,
    };
  if (
    session.runtime.circuitBreakerActive ||
    !session.metrics.risk.newEntriesAllowed
  )
    return {
      title: "New entries paused",
      detail:
        session.metrics.risk.reason ??
        `${positions}. Protective position management continues.`,
      active: false,
    };
  if (mode === "brain")
    return {
      title: "Analysis only",
      detail: `${positions}. Brain cannot open trades.`,
      active: true,
    };
  if (mode === "copilot")
    return {
      title: session.activity.recommendations.length
        ? "Your review is needed"
        : "Watching for a setup",
      detail: `${positions}. Every Co-Pilot entry requires your approval.`,
      active: true,
    };
  if (session.health.marketData.state !== "available")
    return {
      title: "Waiting for current market data",
      detail: `${positions}. Check data status before resuming entries.`,
      active: false,
    };
  if (
    session.context.environment.id !== "CACTUS_DEMO" &&
    session.autopilot?.effectiveState !== "AUTOPILOT_ENABLED"
  )
    return {
      title: "Waiting for AutoPilot authorization",
      detail:
        session.autopilot?.reason ??
        "Review the current authority and shared trade setup.",
      active: false,
    };
  return {
    title: positionCount
      ? `Managing ${positionCount} position${positionCount === 1 ? "" : "s"}`
      : "Scanning for opportunities",
    detail: `${session.context.environment.id === "CACTUS_DEMO" ? "Simulated" : "Authorized"} entries are enabled, subject to server risk checks.`,
    active: true,
  };
}

const metricNames = [
  ["availableFunds", "Available funds"],
  ["realizedDayPnl", "Today's realized P&L"],
  ["equity", "Equity"],
  ["marginUsed", "Margin used"],
  ["exposure", "Exposure"],
  ["drawdown", "Drawdown"],
] as const;

function metricValue(metric: MetricValue) {
  if (
    metric.state === "unavailable" ||
    metric.value === null ||
    !Number.isFinite(metric.value)
  )
    return "Unavailable";
  if (metric.unit === "currency")
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
      signDisplay: "auto",
    }).format(metric.value);
  return metric.unit === "percent"
    ? `${metric.value.toFixed(2)}%`
    : formatTradingNumber(metric.value);
}

export function DashboardMetrics({ session }: { session: DashboardSession }) {
  const [open, setOpen] = useState(false);
  const metricsTrigger = useRef<HTMLButtonElement>(null);
  const complete = metricNames.every(
    ([key]) =>
      session.metrics[key].state === "available" &&
      Number.isFinite(session.metrics[key].value),
  );
  const pnl = session.metrics.realizedDayPnl;
  const items = [
    {
      label: "Available funds",
      value: metricValue(session.metrics.availableFunds),
      sub:
        session.metrics.availableFunds.state === "available"
          ? session.context.account.label
          : session.metrics.availableFunds.state === "stale"
            ? "Stale balance · review details"
            : "Balance data unavailable",
      icon: WalletCards,
      color: "",
    },
    {
      label: "Today's realized P&L",
      value: metricValue(pnl),
      sub:
        pnl.state === "available"
          ? "Closed account trades"
          : `${pnl.state} · review details`,
      icon: ArrowUpRight,
      color:
        pnl.value !== null && pnl.state === "available"
          ? pnl.value >= 0
            ? "text-success"
            : "text-destructive"
          : "",
    },
    {
      label: "Open positions",
      value: session.runtime.openPositionCount.toLocaleString(),
      sub: session.runtime.running ? "Runtime running" : "Runtime stopped",
      icon: Activity,
      color: "",
    },
  ];
  return (
    <>
      <section
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
        aria-label="Account metrics"
      >
        {items.map(({ label, value, sub, icon: Icon, color }) => (
          <div
            key={label}
            className="dashboard-card flex min-w-0 items-start gap-3 p-4"
          >
            <span className="hidden rounded-lg bg-primary/7 p-2.5 text-primary sm:block">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">
                {label}
              </p>
              <p
                className={cn(
                  "mt-1.5 break-words text-lg font-semibold tracking-tight xl:text-2xl",
                  color,
                )}
              >
                {value}
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground">{sub}</p>
            </div>
          </div>
        ))}
        <div className="dashboard-card flex min-w-0 items-start gap-3 p-4">
          <span className="hidden rounded-lg bg-warning/8 p-2.5 text-warning sm:block">
            <ShieldAlert className="h-5 w-5" />
          </span>
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Risk data
            </p>
            <p className="mt-1.5 flex items-center gap-2 text-lg font-semibold xl:text-2xl">
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  complete ? "bg-primary" : "bg-warning",
                )}
              />
              {complete ? "Available" : "Partial"}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {complete
                ? "Account metrics available"
                : "Some account metrics unavailable or stale"}
            </p>
            <button
              type="button"
              className="mt-1 min-h-6 text-xs font-semibold text-primary underline-offset-4 hover:underline"
              ref={metricsTrigger}
              onClick={() => setOpen(true)}
            >
              View details
            </button>
          </div>
        </div>
      </section>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            metricsTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Account metrics</DialogTitle>
            <DialogDescription>
              Balances, exposure, and entry permissions are separate measures.
              Missing or stale data is not a zero value.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid gap-3 sm:grid-cols-2">
            {metricNames.map(([key, label]) => {
              const metric = session.metrics[key];
              return (
                <div key={key} className="rounded-lg border p-3">
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="mt-1 font-semibold">
                    {metricValue(metric)}{" "}
                    <span className="text-xs font-normal capitalize text-muted-foreground">
                      · {metric.state}
                    </span>
                  </dd>
                  <dd className="mt-2 break-words text-xs leading-5 text-muted-foreground">
                    {metric.reason ?? metric.source ?? "Source unavailable"}
                    {metric.observedAt && (
                      <span className="block">
                        Observed {new Date(metric.observedAt).toLocaleString()}
                      </span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          <div className="rounded-lg border p-4 text-sm">
            <strong>
              New entries:{" "}
              {session.metrics.risk.newEntriesAllowed
                ? "Allowed by risk checks"
                : "Blocked"}
            </strong>
            <p className="mt-1 text-xs text-muted-foreground">
              {session.metrics.risk.reason ??
                "Execution also depends on runtime, mode, and server authorization."}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DashboardConnectionStrip({
  session,
}: {
  session: DashboardSession;
}) {
  return (
    <details className="dashboard-card text-xs">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 text-muted-foreground [&::-webkit-details-marker]:hidden">
        {(["api", "marketData", "execution"] as const).map((key) => (
          <span key={key} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                session.health[key].state === "available"
                  ? "bg-success"
                  : "bg-warning",
              )}
            />
            <span>
              {key === "api"
                ? "API"
                : key === "marketData"
                  ? "Market data"
                  : "Execution"}{" "}
              ·{" "}
              <span className="capitalize">
                {session.health[key].label ?? session.health[key].state}
              </span>
            </span>
          </span>
        ))}
        <span className="flex items-center gap-1.5 sm:ml-auto">
          <Clock3 className="h-3.5 w-3.5" />
          Updated {new Date(session.asOf).toLocaleTimeString()}
        </span>
        <span className="font-medium text-primary">Connection details</span>
      </summary>
      <div className="grid gap-5 border-t p-4 sm:grid-cols-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <CircleGauge className="h-4 w-4" />
            Broker, data &amp; execution
          </h2>
          <dl className="mt-3 space-y-3">
            {Object.entries(session.health).map(([key, value]) => (
              <div key={key}>
                <dt className="font-medium capitalize">
                  {key.replace(/([A-Z])/g, " $1")} · {value.state}
                </dt>
                <dd className="mt-1 text-muted-foreground">
                  {value.reason ?? value.label ?? "No additional details"}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h2 className="text-sm font-semibold">Account context</h2>
          <p className="mt-3">
            {session.context.account.label} · {session.context.market} ·{" "}
            {session.context.environment.label}
          </p>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <Link href="/settings?view=connections">
              Manage account and connections
            </Link>
          </Button>
          <ul className="mt-4 list-disc space-y-2 pl-4 leading-5 text-muted-foreground">
            {session.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}

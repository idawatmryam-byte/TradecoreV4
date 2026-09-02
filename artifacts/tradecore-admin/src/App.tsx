import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Route, Switch, useLocation } from "wouter";
import {
  Activity,
  AlertTriangle,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Database,
  FileClock,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  PauseCircle,
  PlayCircle,
  ServerCog,
  Settings2,
  ShieldAlert,
  Sun,
  Users,
  X,
} from "lucide-react";
import { adminApi, AdminApiError, type AdminSessionStatus } from "./api";

type RecordValue = Record<string, unknown>;

function CactusMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="19"
      height="19"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="10.25"
        y="2.5"
        width="3.5"
        height="19"
        rx="1.75"
        fill="currentColor"
      />
      <path
        d="M10.25 13.5H7.6Q5.6 13.5 5.6 11.5V8.8"
        stroke="currentColor"
        strokeWidth="3.1"
        strokeLinecap="round"
      />
      <path
        d="M13.75 11H16.4Q18.4 11 18.4 9V6.6"
        stroke="currentColor"
        strokeWidth="3.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-9 w-9 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
        <CactusMark />
      </span>
      <span>
        <strong className="block text-sm tracking-tight">Cactus AI</strong>
        <span className="admin-kicker block pt-1">Admin Console</span>
      </span>
    </div>
  );
}

function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div
      className="grid min-h-48 place-items-center text-sm text-muted-foreground"
      role="status"
    >
      <span className="flex items-center gap-2">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
        {label}
      </span>
    </div>
  );
}

function ErrorPanel({ error }: { error: unknown }) {
  const message =
    error instanceof Error
      ? error.message
      : "This operational view could not be loaded.";
  return (
    <div
      className="admin-panel flex min-h-40 items-center gap-3 border-destructive/40 p-5 text-sm"
      role="alert"
    >
      <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
      <div>
        <strong className="block">Read failed</strong>
        <span className="mt-1 block text-muted-foreground">{message}</span>
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: unknown }) {
  const text = String(state ?? "UNKNOWN").replaceAll("_", " ");
  const normalized = text.toUpperCase();
  const tone =
    /HEALTHY|AVAILABLE|OPERATIONAL|NORMAL|ACTIVE|ENABLED|CONNECTED|SUCCEEDED/.test(
      normalized,
    )
      ? "border-success/30 bg-success/10 text-success"
      : /BLOCK|FAIL|UNREACHABLE|BREACH|CRITICAL|ESCALAT|SUSPEND/.test(
            normalized,
          )
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : /ATTENTION|DEGRADED|PARTIAL|PENDING|PAUSED|STALE/.test(normalized)
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-border bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-1 text-[10px] font-semibold tracking-wide ${tone}`}
    >
      {text}
    </span>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "Unavailable";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "string") {
    const date = Date.parse(value);
    if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(date)) {
      return new Date(date).toLocaleString();
    }
    return value;
  }
  return JSON.stringify(value);
}

function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="mb-6 max-w-4xl">
      <p className="admin-kicker mb-2">{eyebrow}</p>
      <h1 className="m-0 text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">
        {title}
      </h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {description}
      </p>
    </header>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
}) {
  return (
    <div className="admin-panel p-4">
      <span className="admin-kicker block">{label}</span>
      <strong className="mt-3 block font-mono text-xl font-medium tracking-tight">
        {value}
      </strong>
      {detail && (
        <span className="mt-2 block text-xs leading-5 text-muted-foreground">
          {detail}
        </span>
      )}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-36 place-items-center px-5 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function useAdminData<T>(key: string, path: string, interval?: number) {
  return useQuery({
    queryKey: ["admin", key],
    queryFn: () => adminApi<T>(path),
    refetchInterval: interval,
  });
}

interface OverviewData {
  asOf: string;
  status: string;
  counts: Record<string, number>;
  autopilot: Record<string, number>;
  authorityBoundary: string;
}

interface PlatformAutopilotClearance {
  clearanceId: string;
  state: "PENDING" | "ACTIVE" | "EXPIRED" | "REVOKED";
  requestedByUserId: number;
  approvedByUserId: number | null;
  revokedByUserId: number | null;
  reason: string;
  durationMinutes: number;
  requestedAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface PlatformAutopilotData {
  asOf: string;
  gate: {
    effectiveSuspended: boolean;
    deploymentSuspended: boolean;
    clearanceRequired: boolean;
    reasonCode: string;
    clearance: PlatformAutopilotClearance | null;
  };
  safetyBoundary: string;
}

function PlatformAutopilotPage() {
  const queryClient = useQueryClient();
  const query = useAdminData<PlatformAutopilotData>(
    "autopilot",
    "/autopilot",
    10_000,
  );
  const session = useQuery({
    queryKey: ["admin-session"],
    queryFn: () => adminApi<AdminSessionStatus>("/session/status"),
  });
  const [reason, setReason] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const permissions = session.data?.permissions ?? [];
  const clearance = query.data?.gate.clearance ?? null;

  const mutation = useMutation({
    mutationFn: async (action: "request" | "approve" | "revoke") => {
      if (action === "request") {
        return adminApi("/autopilot/clearances", {
          method: "POST",
          body: JSON.stringify({
            reason,
            durationMinutes,
            confirmation: "REQUEST_BOUNDED_PLATFORM_AUTOPILOT_CLEARANCE",
          }),
        });
      }
      if (!clearance) throw new Error("No platform clearance is available");
      return adminApi(
        `/autopilot/clearances/${clearance.clearanceId}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({
            reason,
            confirmation:
              action === "approve"
                ? "APPROVE_BOUNDED_PLATFORM_AUTOPILOT_CLEARANCE"
                : "REVOKE_PLATFORM_AUTOPILOT_CLEARANCE",
          }),
        },
      );
    },
    onSuccess: async (_result, action) => {
      setReason("");
      setConfirmed(false);
      setMessage(
        action === "request"
          ? "Clearance requested. A different platform administrator must approve it."
          : action === "approve"
            ? "Bounded platform clearance approved. The deployment stop and all tenant safety gates remain authoritative."
            : "Platform clearance revoked; new AutoPilot entries are paused.",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "autopilot"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "audit"] }),
      ]);
    },
  });

  if (query.isLoading || session.isLoading)
    return <Spinner label="Loading platform AutoPilot gate" />;
  if (query.error || !query.data) return <ErrorPanel error={query.error} />;
  const data = query.data;
  const canRequest = permissions.includes("admin.autopilot.clearance.request");
  const canApprove = permissions.includes("admin.autopilot.clearance.approve");
  const canRevoke = permissions.includes("admin.autopilot.clearance.revoke");
  const selfRequested =
    clearance?.requestedByUserId === session.data?.actorUserId;
  const outstanding =
    clearance?.state === "PENDING" || clearance?.state === "ACTIVE";

  return (
    <>
      <PageHeader
        eyebrow="Bounded platform authority"
        title="AutoPilot Clearance"
        description="Authorize the platform gate without bypassing the deployment stop or any tenant trading and risk safeguard."
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Effective platform gate"
          value={
            <StateBadge
              state={data.gate.effectiveSuspended ? "PAUSED" : "CLEAR"}
            />
          }
        />
        <Metric
          label="Deployment hard stop"
          value={
            <StateBadge
              state={data.gate.deploymentSuspended ? "ACTIVE" : "CLEAR"}
            />
          }
          detail="Cannot be overridden from this console"
        />
        <Metric
          label="Admin clearance"
          value={
            <StateBadge
              state={
                clearance?.state ??
                (data.gate.clearanceRequired ? "MISSING" : "NOT REQUIRED")
              }
            />
          }
        />
        <Metric
          label="Gate evidence"
          value={
            <span className="text-sm">
              {data.gate.reasonCode.replaceAll("_", " ")}
            </span>
          }
          detail={`As of ${formatValue(data.asOf)}`}
        />
      </div>

      <section className="admin-panel mt-5 border-warning/30 bg-warning/5 p-5">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div>
            <h2 className="m-0 text-sm font-semibold">Safety boundary</h2>
            <p className="mb-0 mt-2 text-sm leading-6 text-muted-foreground">
              {data.safetyBoundary}
            </p>
          </div>
        </div>
      </section>

      {clearance && (
        <section className="admin-panel mt-5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="m-0 text-sm font-semibold">
              Current clearance evidence
            </h2>
            <StateBadge state={clearance.state} />
          </div>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Requested by</dt>
              <dd className="m-0 mt-1 font-mono">
                User {clearance.requestedByUserId}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Approved by</dt>
              <dd className="m-0 mt-1 font-mono">
                {clearance.approvedByUserId
                  ? `User ${clearance.approvedByUserId}`
                  : "Awaiting second admin"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="m-0 mt-1 font-mono">
                {clearance.durationMinutes} minutes
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Expires</dt>
              <dd className="m-0 mt-1 font-mono">
                {formatValue(clearance.expiresAt)}
              </dd>
            </div>
          </dl>
          <p className="mb-0 mt-4 rounded-lg border bg-background/40 p-3 text-sm">
            {clearance.reason}
          </p>
        </section>
      )}

      {(canRequest || canApprove || canRevoke) && (
        <section className="admin-panel mt-5 max-w-3xl p-5 sm:p-6">
          <h2 className="m-0 text-sm font-semibold">Operator action</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Requests and approvals are append-only. Approval must come from a
            different platform administrator and expires automatically after at
            most 24 hours. Revocation is immediate.
          </p>
          <div className="mt-5 space-y-4">
            {!outstanding && canRequest && (
              <label
                className="block text-sm font-medium"
                htmlFor="clearance-duration"
              >
                Clearance duration
                <select
                  id="clearance-duration"
                  value={durationMinutes}
                  onChange={(event) =>
                    setDurationMinutes(Number(event.target.value))
                  }
                  className="mt-2 min-h-11 w-full rounded-lg border bg-background px-3"
                >
                  <option value={15}>15 minutes</option>
                  <option value={60}>1 hour</option>
                  <option value={240}>4 hours</option>
                  <option value={480}>8 hours</option>
                  <option value={1440}>24 hours</option>
                </select>
              </label>
            )}
            <label
              className="block text-sm font-medium"
              htmlFor="clearance-reason"
            >
              Operator reason
              <textarea
                id="clearance-reason"
                minLength={8}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="mt-2 min-h-24 w-full rounded-lg border bg-background p-3"
              />
            </label>
            <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-1"
              />
              <span>
                I confirm this action does not bypass the deployment suspension
                or grant tenant, broker, mandate, or Live trading authority.
              </span>
            </label>
            {mutation.error && (
              <p
                className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
              >
                {mutation.error.message}
              </p>
            )}
            {message && (
              <p
                className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-primary"
                role="status"
              >
                {message}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              {!outstanding && canRequest && (
                <button
                  type="button"
                  disabled={
                    mutation.isPending || reason.trim().length < 8 || !confirmed
                  }
                  onClick={() => mutation.mutate("request")}
                  className="min-h-11 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  Request clearance
                </button>
              )}
              {clearance?.state === "PENDING" && canApprove && (
                <button
                  type="button"
                  disabled={
                    mutation.isPending ||
                    selfRequested ||
                    reason.trim().length < 8 ||
                    !confirmed
                  }
                  onClick={() => mutation.mutate("approve")}
                  className="min-h-11 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  Approve as second admin
                </button>
              )}
              {outstanding && canRevoke && (
                <button
                  type="button"
                  disabled={
                    mutation.isPending || reason.trim().length < 8 || !confirmed
                  }
                  onClick={() => mutation.mutate("revoke")}
                  className="min-h-11 rounded-lg border border-destructive/40 px-5 text-sm font-semibold text-destructive disabled:opacity-50"
                >
                  Revoke clearance
                </button>
              )}
            </div>
            {clearance?.state === "PENDING" && selfRequested && (
              <p className="text-xs text-muted-foreground">
                You requested this clearance. A different platform administrator
                must sign in and approve it.
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}

function OverviewPage() {
  const query = useAdminData<OverviewData>("overview", "/overview", 15_000);
  if (query.isLoading) return <Spinner label="Loading platform overview" />;
  if (query.error || !query.data) return <ErrorPanel error={query.error} />;
  const data = query.data;
  return (
    <>
      <PageHeader
        eyebrow="Platform operations"
        title="Overview"
        description="A bounded, cross-platform summary built only from persisted operational evidence."
      />
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
        <StateBadge state={data.status} />
        <span className="text-xs text-muted-foreground">
          As of {formatValue(data.asOf)}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Object.entries(data.counts).map(([label, value]) => (
          <Metric
            key={label}
            label={label.replace(/([A-Z])/g, " $1")}
            value={value.toLocaleString()}
          />
        ))}
      </div>
      <div className="mt-5 grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
        <section className="admin-panel p-5">
          <h2 className="m-0 text-sm font-semibold">
            AutoPilot control projections
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {Object.entries(data.autopilot).length ? (
              Object.entries(data.autopilot).map(([state, value]) => (
                <div
                  key={state}
                  className="rounded-lg border bg-background/40 p-3"
                >
                  <StateBadge state={state} />
                  <strong className="mt-3 block font-mono text-lg">
                    {value}
                  </strong>
                </div>
              ))
            ) : (
              <Empty>No AutoPilot control projections are present.</Empty>
            )}
          </div>
        </section>
        <section className="admin-panel border-warning/30 bg-warning/5 p-5">
          <ShieldAlert className="h-5 w-5 text-warning" />
          <h2 className="mt-3 text-sm font-semibold">Authority boundary</h2>
          <p className="mb-0 text-sm leading-6 text-muted-foreground">
            {data.authorityBoundary}
          </p>
        </section>
      </div>
    </>
  );
}

interface HealthData {
  asOf: string;
  services: Record<string, RecordValue>;
  resources: Record<string, number>;
}

function HealthPage() {
  const query = useAdminData<HealthData>("health", "/health", 15_000);
  if (query.isLoading) return <Spinner label="Loading system health" />;
  if (query.error || !query.data) return <ErrorPanel error={query.error} />;
  return (
    <>
      <PageHeader
        eyebrow="Operational evidence"
        title="System Health"
        description="Real checks are shown with their source. Missing subsystems are explicitly not provisioned—not inferred healthy."
      />
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {Object.entries(query.data.services).map(([name, service]) => (
          <section key={name} className="admin-panel p-5">
            <div className="flex items-start justify-between gap-3">
              <h2 className="m-0 capitalize text-sm font-semibold">
                {name.replace(/([A-Z])/g, " $1")}
              </h2>
              <StateBadge state={service.state} />
            </div>
            <dl className="mt-4 space-y-2 text-xs">
              {Object.entries(service)
                .filter(([key]) => key !== "state")
                .map(([key, value]) => (
                  <div
                    key={key}
                    className="grid grid-cols-[minmax(100px,.7fr)_1.3fr] gap-3 border-t pt-2"
                  >
                    <dt className="text-muted-foreground">
                      {key.replace(/([A-Z])/g, " $1")}
                    </dt>
                    <dd className="m-0 break-words text-right font-mono">
                      {formatValue(value)}
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
      <section className="admin-panel mt-4 p-5">
        <h2 className="m-0 text-sm font-semibold">Process resources</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {Object.entries(query.data.resources).map(([label, bytes]) => (
            <Metric
              key={label}
              label={label.replace(/([A-Z])/g, " $1")}
              value={`${(bytes / 1024 / 1024).toFixed(1)} MB`}
            />
          ))}
        </div>
      </section>
    </>
  );
}

interface AiData {
  deterministicBrain: {
    supported: boolean;
    controlVersion: string;
    controlCommit: string;
    versions: Array<RecordValue>;
  };
  externalProviders: {
    supported: boolean;
    providers: unknown[];
    reason: string;
  };
  mutationsSupported: boolean;
}

function AiPage() {
  const query = useAdminData<AiData>("ai", "/ai", 30_000);
  if (query.isLoading) return <Spinner label="Loading Brain infrastructure" />;
  if (query.error || !query.data) return <ErrorPanel error={query.error} />;
  const data = query.data;
  return (
    <>
      <PageHeader
        eyebrow="AI infrastructure"
        title="AI / Brain"
        description="Deterministic Brain evidence is visible now. Provider and model controls stay absent until a real adapter and SecretStore contract exist."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Metric
          label="Control version"
          value={data.deterministicBrain.controlVersion}
        />
        <Metric
          label="Control commit"
          value={
            <span className="text-sm">
              {data.deterministicBrain.controlCommit.slice(0, 12)}
            </span>
          }
          detail="Immutable source identity"
        />
        <Metric
          label="External providers"
          value={
            data.externalProviders.supported ? "Available" : "Not provisioned"
          }
          detail={data.externalProviders.reason}
        />
      </div>
      <section className="admin-panel mt-5 overflow-hidden">
        <div className="border-b p-4">
          <h2 className="m-0 text-sm font-semibold">
            Registered Brain projections
          </h2>
        </div>
        {data.deterministicBrain.versions.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Implementation</th>
                  <th>State</th>
                  <th>Assignments</th>
                  <th>Fingerprint</th>
                </tr>
              </thead>
              <tbody>
                {data.deterministicBrain.versions.map((row, index) => (
                  <tr key={`${String(row.fingerprint)}:${index}`}>
                    <td className="font-mono">{formatValue(row.version)}</td>
                    <td>{formatValue(row.implementation)}</td>
                    <td>
                      <StateBadge state={row.state} />
                    </td>
                    <td className="font-mono">
                      {formatValue(row.assignments)}
                    </td>
                    <td
                      className="max-w-48 truncate font-mono text-xs"
                      title={String(row.fingerprint)}
                    >
                      {formatValue(row.fingerprint).slice(0, 16)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No Brain versions have been registered.</Empty>
        )}
      </section>
    </>
  );
}

interface ExecutionData {
  asOf: string;
  unresolvedIntents: Array<RecordValue>;
  accountStates: Array<RecordValue>;
  controlsSupported: boolean;
  authorityBoundary: string;
}

function ExecutionPage() {
  const query = useAdminData<ExecutionData>("execution", "/execution", 10_000);
  if (query.isLoading) return <Spinner label="Loading execution evidence" />;
  if (query.error || !query.data) return <ErrorPanel error={query.error} />;
  return (
    <>
      <PageHeader
        eyebrow="Financial infrastructure"
        title="Execution"
        description="Cross-tenant intent and safety projections are read-only. This console does not provide a parallel execution route."
      />
      <section className="admin-panel overflow-hidden">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="m-0 text-sm font-semibold">
            Unresolved execution intents
          </h2>
          <StateBadge
            state={
              query.data.unresolvedIntents.length
                ? "ATTENTION REQUIRED"
                : "CLEAR"
            }
          />
        </div>
        {query.data.unresolvedIntents.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>User / Market</th>
                  <th>Symbol</th>
                  <th>State</th>
                  <th>Strategy</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {query.data.unresolvedIntents.map((row) => (
                  <tr key={String(row.id)}>
                    <td className="font-mono">{formatValue(row.id)}</td>
                    <td>
                      {formatValue(row.userId)} · {formatValue(row.section)}
                    </td>
                    <td className="font-mono">{formatValue(row.symbol)}</td>
                    <td>
                      <StateBadge state={row.state} />
                    </td>
                    <td>{formatValue(row.strategyId)}</td>
                    <td>{formatValue(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No unresolved execution intents were returned.</Empty>
        )}
      </section>
      <section className="admin-panel mt-5 overflow-hidden">
        <div className="border-b p-4">
          <h2 className="m-0 text-sm font-semibold">
            Tenant Live safety projections
          </h2>
        </div>
        {query.data.accountStates.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User / Market</th>
                  <th>Operating mode</th>
                  <th>Reconciliation</th>
                  <th>Protection</th>
                  <th>Drawdown</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {query.data.accountStates.map((row, index) => (
                  <tr
                    key={`${String(row.userId)}:${String(row.section)}:${index}`}
                  >
                    <td>
                      {formatValue(row.userId)} · {formatValue(row.section)}
                    </td>
                    <td>
                      <StateBadge state={row.operatingMode} />
                    </td>
                    <td>
                      <StateBadge state={row.reconciliationState} />
                    </td>
                    <td>
                      <StateBadge state={row.protectionState} />
                    </td>
                    <td>
                      <StateBadge state={row.accountDrawdownState} />
                    </td>
                    <td>{formatValue(row.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No persisted Live safety projections were returned.</Empty>
        )}
      </section>
      <p className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm text-muted-foreground">
        {query.data.authorityBoundary}
      </p>
    </>
  );
}

interface RiskData {
  activeSwitches: Array<RecordValue>;
  incidents: Array<RecordValue>;
  controlsSupported: boolean;
  controlsReason: string;
  platformAutopilot: {
    effectiveSuspended: boolean;
    source: string;
    reason: string;
    deploymentHardStop: {
      active: boolean;
      configured: boolean;
      reason: string | null;
    };
    persisted: {
      initialized: boolean;
      suspended: boolean;
      updatedAt: string | null;
    };
    pendingResume: {
      requestId: string;
      requestedByUserId: number;
      requestedAt: string;
      expiresAt: string;
      reason: string;
      canCurrentOperatorApprove: boolean;
    } | null;
  };
}

function RiskPage({ session }: { session: AdminSessionStatus }) {
  const query = useAdminData<RiskData>("risk", "/risk", 10_000);
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const action = useMutation({
    mutationFn: async (
      kind: "request-resume" | "approve-resume" | "suspend",
    ) => {
      if (!query.data) throw new Error("Platform safety state is unavailable");
      if (kind === "request-resume") {
        return adminApi<RiskData["platformAutopilot"]>(
          "/risk/autopilot/resume-requests",
          {
            method: "POST",
            body: JSON.stringify({
              reason,
              clientRequestId: crypto.randomUUID(),
              confirmation: "REQUEST_PLATFORM_AUTOPILOT_RESUME",
            }),
          },
        );
      }
      if (kind === "approve-resume") {
        const resumeRequestId =
          query.data.platformAutopilot.pendingResume?.requestId;
        if (!resumeRequestId)
          throw new Error("No resume request is awaiting approval");
        return adminApi<RiskData["platformAutopilot"]>(
          "/risk/autopilot/resume-approvals",
          {
            method: "POST",
            body: JSON.stringify({
              reason,
              resumeRequestId,
              confirmation: "APPROVE_PLATFORM_AUTOPILOT_RESUME",
            }),
          },
        );
      }
      return adminApi<RiskData["platformAutopilot"]>(
        "/risk/autopilot/suspend",
        {
          method: "POST",
          body: JSON.stringify({
            reason,
            confirmation: "SUSPEND_PLATFORM_AUTOPILOT",
          }),
        },
      );
    },
    onSuccess: async () => {
      setReason("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "risk"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "audit"] }),
      ]);
    },
  });
  if (query.isLoading)
    return <Spinner label="Loading risk and safety evidence" />;
  if (query.error || !query.data) return <ErrorPanel error={query.error} />;
  const safety = query.data.platformAutopilot;
  const canSuspend = session.permissions.includes("admin.risk.suspend");
  const canRequestResume = session.permissions.includes(
    "admin.risk.resume.request",
  );
  const canApproveResume = session.permissions.includes(
    "admin.risk.resume.approve",
  );
  const validReason = reason.trim().length >= 8;
  return (
    <>
      <PageHeader
        eyebrow="Safety boundaries"
        title="Risk & Safety"
        description="Immediately suspend broker sandbox AutoPilot or use a two-operator review to resume it. Internal Demo is independent and Live authority is not granted here."
      />
      <section className="admin-panel mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="admin-kicker m-0">Broker Sandbox AutoPilot</p>
            <div className="mt-2 flex items-center gap-2">
              <StateBadge
                state={safety.effectiveSuspended ? "SUSPENDED" : "ENABLED"}
              />
              <span className="text-sm text-muted-foreground">
                {safety.reason}
              </span>
            </div>
          </div>
          <span className="text-xs text-muted-foreground">
            Source: {formatValue(safety.source)}
          </span>
        </div>

        {safety.deploymentHardStop.active ? (
          <div
            className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
            role="alert"
          >
            <strong className="block">
              Deployment emergency hard stop is active
            </strong>
            <span className="mt-1 block">
              Admin approval cannot override it. Remove the explicit deployment
              hard stop through the reviewed VPS deployment process first.
            </span>
          </div>
        ) : (
          <div className="mt-5 border-t pt-5">
            <label
              htmlFor="platform-autopilot-reason"
              className="text-sm font-medium"
            >
              Operator reason
            </label>
            <textarea
              id="platform-autopilot-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              placeholder="Explain why this safety-state change is required"
              className="mt-2 min-h-24 w-full rounded-lg border bg-background p-3 text-sm focus:border-primary"
            />
            {action.error && (
              <p
                className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
              >
                {action.error.message}
              </p>
            )}

            {safety.effectiveSuspended &&
              !safety.pendingResume &&
              canRequestResume && (
                <button
                  type="button"
                  disabled={!validReason || action.isPending}
                  onClick={() => action.mutate("request-resume")}
                  className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  <PlayCircle className="h-4 w-4" /> Request sandbox AutoPilot
                  resume
                </button>
              )}

            {safety.effectiveSuspended && safety.pendingResume && (
              <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-4">
                <strong className="text-sm">
                  Resume awaiting a second operator
                </strong>
                <p className="mb-0 mt-2 text-xs leading-5 text-muted-foreground">
                  Requested by operator {safety.pendingResume.requestedByUserId}{" "}
                  · expires {formatValue(safety.pendingResume.expiresAt)} ·{" "}
                  {safety.pendingResume.reason}
                </p>
                {safety.pendingResume.canCurrentOperatorApprove &&
                canApproveResume ? (
                  <button
                    type="button"
                    disabled={!validReason || action.isPending}
                    onClick={() => action.mutate("approve-resume")}
                    className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4 w-4" /> Approve and resume Demo
                    AutoPilot
                  </button>
                ) : (
                  <p className="mb-0 mt-3 text-xs font-medium text-warning">
                    A different qualified administrator must approve this
                    request.
                  </p>
                )}
              </div>
            )}

            {!safety.effectiveSuspended && canSuspend && (
              <button
                type="button"
                disabled={!validReason || action.isPending}
                onClick={() => action.mutate("suspend")}
                className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground disabled:opacity-50"
              >
                <PauseCircle className="h-4 w-4" /> Suspend new AutoPilot
                entries
              </button>
            )}
          </div>
        )}
      </section>
      <div className="grid gap-3 sm:grid-cols-2">
        <Metric
          label="Active safety switches"
          value={query.data.activeSwitches.length}
        />
        <Metric
          label="Recent incidents"
          value={query.data.incidents.length}
          detail="Latest 200 persisted events"
        />
      </div>
      <section className="admin-panel mt-5 overflow-hidden">
        <div className="border-b p-4">
          <h2 className="m-0 text-sm font-semibold">Active switches</h2>
        </div>
        {query.data.activeSwitches.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Scope</th>
                  <th>User / Market</th>
                  <th>Reason</th>
                  <th>Activated</th>
                </tr>
              </thead>
              <tbody>
                {query.data.activeSwitches.map((row) => (
                  <tr key={String(row.id)}>
                    <td>
                      <StateBadge state={row.source} />
                    </td>
                    <td>
                      {formatValue(row.scope)} · {formatValue(row.scopeKey)}
                    </td>
                    <td>
                      {formatValue(row.ownerUserId)} ·{" "}
                      {formatValue(row.section)}
                    </td>
                    <td className="max-w-md">{formatValue(row.reason)}</td>
                    <td>{formatValue(row.activatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No active safety switches were returned.</Empty>
        )}
      </section>
      <section className="admin-panel mt-5 overflow-hidden">
        <div className="border-b p-4">
          <h2 className="m-0 text-sm font-semibold">Recent safety evidence</h2>
        </div>
        {query.data.incidents.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Target</th>
                  <th>Reason</th>
                  <th>Actor</th>
                  <th>Occurred</th>
                </tr>
              </thead>
              <tbody>
                {query.data.incidents.map((row) => (
                  <tr key={String(row.id)}>
                    <td>
                      <StateBadge state={row.eventType} />
                    </td>
                    <td>
                      {formatValue(row.targetUserId)} ·{" "}
                      {formatValue(row.section)}
                    </td>
                    <td className="max-w-lg">
                      <strong className="block text-xs">
                        {formatValue(row.reasonCode)}
                      </strong>
                      <span className="text-muted-foreground">
                        {formatValue(row.reason)}
                      </span>
                    </td>
                    <td>{formatValue(row.actorType)}</td>
                    <td>{formatValue(row.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No safety events were returned.</Empty>
        )}
      </section>
      <p className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm text-muted-foreground">
        {query.data.controlsReason}
      </p>
    </>
  );
}

interface UsersData {
  users: Array<RecordValue>;
  nextAfterId: number | null;
  mutationsSupported: boolean;
}

function UsersPage() {
  const query = useAdminData<UsersData>("users", "/users?limit=100");
  if (query.isLoading) return <Spinner label="Loading user access directory" />;
  if (query.error || !query.data) return <ErrorPanel error={query.error} />;
  return (
    <>
      <PageHeader
        eyebrow="Least privilege"
        title="Users & Access"
        description="Platform roles and tenant financial roles are shown in separate columns. Broker credentials are never available here."
      />
      <section className="admin-panel overflow-hidden">
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Masked email</th>
                <th>Tenant financial role</th>
                <th>Platform roles</th>
                <th>Access state</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {query.data.users.map((row) => (
                <tr key={String(row.id)}>
                  <td>
                    <strong className="block">
                      {formatValue(row.displayName ?? row.username)}
                    </strong>
                    <span className="font-mono text-xs text-muted-foreground">
                      #{formatValue(row.id)} · {formatValue(row.username)}
                    </span>
                  </td>
                  <td>{formatValue(row.maskedEmail)}</td>
                  <td>
                    <StateBadge state={row.financialRole} />
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {Array.isArray(row.platformRoles) &&
                      row.platformRoles.length ? (
                        row.platformRoles.map((role) => (
                          <StateBadge key={String(role)} state={role} />
                        ))
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <StateBadge state={row.accessState} />
                  </td>
                  <td>{formatValue(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {!query.data.mutationsSupported && (
        <p className="mt-4 rounded-lg border bg-surface p-4 text-sm text-muted-foreground">
          Role and account mutations are intentionally unavailable in Admin v1.
          There is no self-promotion or impersonation endpoint.
        </p>
      )}
    </>
  );
}

interface AuditData {
  events: Array<RecordValue>;
  nextBeforeId: number | null;
  appendOnly: boolean;
}

function AuditPage() {
  const query = useAdminData<AuditData>("audit", "/audit?limit=100");
  if (query.isLoading) return <Spinner label="Loading platform audit" />;
  if (query.error || !query.data) return <ErrorPanel error={query.error} />;
  return (
    <>
      <PageHeader
        eyebrow="Operator evidence"
        title="Audit"
        description="Append-only platform evidence contains actors, permissions, targets, request IDs, results, and redacted metadata—never secret values."
      />
      <section className="admin-panel overflow-hidden">
        {query.data.events.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Action / Permission</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th>Result</th>
                  <th>Request ID</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {query.data.events.map((row) => (
                  <tr key={String(row.id)}>
                    <td className="font-mono">{formatValue(row.id)}</td>
                    <td>
                      <strong className="block text-xs">
                        {formatValue(row.action)}
                      </strong>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {formatValue(row.permission)}
                      </span>
                    </td>
                    <td>{formatValue(row.actorUserId)}</td>
                    <td>
                      {formatValue(row.targetType)} ·{" "}
                      {formatValue(row.targetId)}
                    </td>
                    <td>
                      <StateBadge state={row.result} />
                    </td>
                    <td
                      className="max-w-48 truncate font-mono text-xs"
                      title={String(row.requestId)}
                    >
                      {formatValue(row.requestId)}
                    </td>
                    <td>{formatValue(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No platform audit events were returned.</Empty>
        )}
      </section>
    </>
  );
}

interface ConfigData {
  capabilities: Record<string, boolean>;
  supported: Record<string, boolean>;
  notice: string;
}

function ConfigurationPage() {
  const query = useAdminData<ConfigData>(
    "configuration",
    "/configuration",
    60_000,
  );
  if (query.isLoading) return <Spinner label="Loading platform capabilities" />;
  if (query.error || !query.data) return <ErrorPanel error={query.error} />;
  return (
    <>
      <PageHeader
        eyebrow="Capability manifest"
        title="Platform Configuration"
        description="Only capability-backed platform configuration is presented. Unsupported systems do not receive fake forms."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="admin-panel p-5">
          <h2 className="m-0 text-sm font-semibold">Current capabilities</h2>
          <ul className="mt-4 space-y-2 p-0">
            {Object.entries(query.data.capabilities).map(([name, enabled]) => (
              <li
                key={name}
                className="flex items-center justify-between gap-4 border-t pt-2 text-sm"
              >
                <span>{name.replace(/([A-Z])/g, " $1")}</span>
                <StateBadge state={enabled ? "SUPPORTED" : "NOT PROVISIONED"} />
              </li>
            ))}
          </ul>
        </section>
        <section className="admin-panel p-5">
          <h2 className="m-0 text-sm font-semibold">
            Operational architecture
          </h2>
          <ul className="mt-4 space-y-2 p-0">
            {Object.entries(query.data.supported).map(([name, enabled]) => (
              <li
                key={name}
                className="flex items-center justify-between gap-4 border-t pt-2 text-sm"
              >
                <span>{name.replace(/([A-Z])/g, " $1")}</span>
                <StateBadge state={enabled ? "SUPPORTED" : "UNSUPPORTED"} />
              </li>
            ))}
          </ul>
        </section>
      </div>
      <p className="mt-4 rounded-lg border bg-surface p-4 text-sm text-muted-foreground">
        {query.data.notice}
      </p>
    </>
  );
}

function AdminSettingsPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      if (newPassword.length < 12)
        throw new Error("New password must be at least 12 characters.");
      if (newPassword !== confirmation)
        throw new Error("New password and confirmation must match.");
      const response = await fetch("/api/me/account/password", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(
          payload?.error ??
            `Password update failed with HTTP ${response.status}`,
        );
      try {
        await adminApi<{ ok: boolean; expiresAt: string }>("/session/step-up", {
          method: "POST",
          body: JSON.stringify({ password: newPassword }),
        });
        return { adminSessionRenewed: true } as const;
      } catch {
        return { adminSessionRenewed: false } as const;
      }
    },
    onSuccess: async (result) => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setMessage(
        result.adminSessionRenewed
          ? "Password changed. Other account and Admin Console sessions were revoked."
          : "Password changed, but this Admin Console session could not be renewed. Sign in again with the new password.",
      );
      await queryClient.invalidateQueries({ queryKey: ["admin-session"] });
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    mutation.mutate();
  }
  return (
    <>
      <PageHeader
        eyebrow="Account security"
        title="Admin Settings"
        description="Change the password for this administrator account. Passwords are hashed server-side and are never displayed after submission."
      />
      <section className="admin-panel max-w-2xl p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <KeyRound className="h-5 w-5" />
          </span>
          <div>
            <h2 className="m-0 text-sm font-semibold">
              Change administrator password
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Changing it revokes previously issued account and Admin Console
              sessions.
            </p>
          </div>
        </div>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <label
            className="block text-sm font-medium"
            htmlFor="settings-current-password"
          >
            Current password
            <input
              id="settings-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className="mt-2 min-h-11 w-full rounded-lg border bg-background px-3"
            />
          </label>
          <label
            className="block text-sm font-medium"
            htmlFor="settings-new-password"
          >
            New password
            <input
              id="settings-new-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="mt-2 min-h-11 w-full rounded-lg border bg-background px-3"
            />
          </label>
          <label
            className="block text-sm font-medium"
            htmlFor="settings-confirm-password"
          >
            Confirm new password
            <input
              id="settings-confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="mt-2 min-h-11 w-full rounded-lg border bg-background px-3"
            />
          </label>
          {mutation.error && (
            <p
              className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              {mutation.error.message}
            </p>
          )}
          {message && (
            <p
              className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-primary"
              role="status"
            >
              {message}
            </p>
          )}
          <button
            disabled={
              mutation.isPending ||
              !currentPassword ||
              !newPassword ||
              !confirmation
            }
            className="min-h-11 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {mutation.isPending ? "Changing password…" : "Change password"}
          </button>
        </form>
      </section>
    </>
  );
}

function NotFound() {
  return (
    <div className="admin-panel grid min-h-64 place-items-center p-6 text-center">
      <div>
        <strong className="text-2xl">Admin view not found</strong>
        <p className="text-sm text-muted-foreground">
          Return to the operational overview.
        </p>
        <Link href="/" className="text-sm font-semibold text-primary">
          Open Overview
        </Link>
      </div>
    </div>
  );
}

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/autopilot", label: "AutoPilot Clearance", icon: Bot },
  { href: "/health", label: "System Health", icon: Activity },
  { href: "/ai", label: "AI / Brain", icon: BrainCircuit },
  { href: "/execution", label: "Execution", icon: ServerCog },
  { href: "/risk", label: "Risk & Safety", icon: ShieldAlert },
  { href: "/users", label: "Users & Access", icon: Users },
  { href: "/audit", label: "Audit", icon: FileClock },
  { href: "/configuration", label: "Platform Configuration", icon: Settings2 },
  { href: "/settings", label: "Admin Settings", icon: KeyRound },
] as const;

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem("cactus.admin.theme") !== "light";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("cactus.admin.theme", dark ? "dark" : "light");
    } catch {
      /* device preference only */
    }
  }, [dark]);
  return { dark, setDark };
}

function AdminShell({ session }: { session: AdminSessionStatus }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const queryClient = useQueryClient();
  const theme = useTheme();
  const title =
    NAV.find((item) => item.href === location)?.label ?? "Admin Console";
  const traderPath = import.meta.env.VITE_TRADER_PATH ?? "/app/dashboard";

  useEffect(() => {
    document.title = `${title} — Cactus AI Admin`;
    setMobileOpen(false);
    const main = document.getElementById("admin-main");
    main?.focus({ preventScroll: true });
  }, [location, title]);

  async function endStepUp() {
    await adminApi<{ ok: boolean }>("/session/logout", { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["admin-session"] });
  }

  const nav = (
    <div className="flex h-full flex-col p-4">
      <Brand />
      <nav className="mt-7 space-y-1" aria-label="Admin Console">
        {NAV.map((item) => {
          const active = location === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${active ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto space-y-3 pt-6">
        <div className="rounded-lg border bg-background/50 p-3 text-xs">
          <span className="admin-kicker block">Active roles</span>
          <div className="mt-2 flex flex-wrap gap-1">
            {session.roles.map((role) => (
              <StateBadge key={role} state={role} />
            ))}
          </div>
          {session.stepUp.active && (
            <span className="mt-2 block text-muted-foreground">
              Step-up expires {formatValue(session.stepUp.expiresAt)}
            </span>
          )}
        </div>
        <a
          href={traderPath}
          className="flex min-h-10 items-center justify-between rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Trader workspace <ChevronRight className="h-4 w-4" />
        </a>
        <button
          type="button"
          onClick={endStepUp}
          className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border bg-background text-sm font-medium hover:bg-muted"
        >
          <LogOut className="h-4 w-4" />
          End admin session
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-[100dvh] bg-background text-foreground md:grid md:grid-cols-[248px_minmax(0,1fr)]">
      <a
        href="#admin-main"
        className="fixed left-3 top-3 z-[100] -translate-y-24 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground focus:translate-y-0"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-[100dvh] border-r bg-surface md:block">
        {nav}
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            className="absolute inset-0 bg-black/60"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-[min(86vw,320px)] border-r bg-surface">
            {nav}
            <button
              aria-label="Close navigation"
              className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-lg hover:bg-muted"
              onClick={() => setMobileOpen(false)}
            >
              <X className="h-5 w-5" />
            </button>
          </aside>
        </div>
      )}
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex min-h-16 items-center justify-between border-b bg-background/90 px-4 backdrop-blur-xl sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="grid h-10 w-10 place-items-center rounded-lg border bg-surface md:hidden"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </button>
            <div>
              <span className="admin-kicker block">Platform operations</span>
              <strong className="mt-1 block text-sm">{title}</strong>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[10px] font-semibold text-warning sm:inline-flex">
              NO TRADING AUTHORITY
            </span>
            <button
              type="button"
              aria-label={theme.dark ? "Use light theme" : "Use dark theme"}
              className="grid h-10 w-10 place-items-center rounded-lg border bg-surface hover:bg-muted"
              onClick={() => theme.setDark(!theme.dark)}
            >
              {theme.dark ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>
          </div>
        </header>
        <main
          id="admin-main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1680px] p-4 outline-none sm:p-6 lg:p-8"
        >
          <Switch>
            <Route path="/" component={OverviewPage} />
            <Route path="/autopilot" component={PlatformAutopilotPage} />
            <Route path="/health" component={HealthPage} />
            <Route path="/ai" component={AiPage} />
            <Route path="/execution" component={ExecutionPage} />
            <Route path="/risk">{() => <RiskPage session={session} />}</Route>
            <Route path="/users" component={UsersPage} />
            <Route path="/audit" component={AuditPage} />
            <Route path="/configuration" component={ConfigurationPage} />
            <Route path="/settings" component={AdminSettingsPage} />
            <Route component={NotFound} />
          </Switch>
        </main>
      </div>
    </div>
  );
}

function StepUp({ session }: { session: AdminSessionStatus }) {
  const [password, setPassword] = useState("");
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      adminApi<{ ok: boolean; expiresAt: string }>("/session/step-up", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    onSuccess: async () => {
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["admin-session"] });
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (password) mutation.mutate();
  }
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-background p-5">
      <div className="w-full max-w-md">
        <Brand />
        <section className="admin-panel mt-6 p-6 sm:p-8">
          <span className="grid h-11 w-11 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <KeyRound className="h-5 w-5" />
          </span>
          <p className="admin-kicker mt-5">Recent authentication required</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Open the Admin Console
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Re-enter your current account password. This creates a short-lived,
            HttpOnly admin step-up session; it does not grant a platform role or
            financial authority.
          </p>
          <form onSubmit={submit} className="mt-6 space-y-4">
            <label
              className="block text-sm font-medium"
              htmlFor="admin-password"
            >
              Current password
            </label>
            <input
              id="admin-password"
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="min-h-11 w-full rounded-lg border bg-background px-3 text-sm focus:border-primary"
            />
            {mutation.error && (
              <p
                className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
              >
                {mutation.error.message}
              </p>
            )}
            <button
              disabled={!password || mutation.isPending}
              className="min-h-11 w-full rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:brightness-110"
            >
              {mutation.isPending ? "Verifying…" : "Verify and continue"}
            </button>
          </form>
          <div className="mt-5 flex flex-wrap gap-1">
            {session.roles.map((role) => (
              <StateBadge key={role} state={role} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function NoAccess() {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-background p-5">
      <section className="admin-panel max-w-lg p-8 text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-lg border bg-muted text-muted-foreground">
          <LockKeyhole className="h-6 w-6" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold">
          Platform access is not assigned
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Admin data is protected by server-side platform roles. Hiding or
          guessing an `/admin` URL never grants access.
        </p>
        <a
          href={import.meta.env.VITE_TRADER_PATH ?? "/app/dashboard"}
          className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"
        >
          Return to trader workspace
        </a>
      </section>
    </div>
  );
}

export default function App() {
  const sessionQuery = useQuery({
    queryKey: ["admin-session"],
    queryFn: () => adminApi<AdminSessionStatus>("/session/status"),
    retry: (count, error) =>
      !(error instanceof AdminApiError && error.status === 401) && count < 1,
    refetchInterval: 30_000,
  });
  if (sessionQuery.isLoading)
    return <Spinner label="Checking platform access" />;
  if (sessionQuery.error || !sessionQuery.data)
    return (
      <div className="grid min-h-[100dvh] place-items-center p-5">
        <ErrorPanel error={sessionQuery.error} />
      </div>
    );
  if (!sessionQuery.data.eligible) return <NoAccess />;
  if (!sessionQuery.data.stepUp.active)
    return <StepUp session={sessionQuery.data} />;
  return <AdminShell session={sessionQuery.data} />;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useTheme } from "next-themes";
import {
  Activity,
  Bitcoin,
  CandlestickChart,
  ChevronRight,
  FlaskConical,
  LayoutDashboard,
  Layers3,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sun,
  UserCircle2,
} from "lucide-react";
import {
  getGetConfigQueryKey,
  getGetBotStatusQueryKey,
  getGetExecutionHealthQueryKey,
  getGetSectionsQueryKey,
  useGetBotStatus,
  useGetConfig,
  useGetExecutionHealth,
  useGetSections,
} from "@workspace/api-client-react";
import { CactusLogo } from "@/components/cactus-logo";
import { NotificationBell } from "@/components/notification-bell";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAccount } from "@/lib/account";
import { useSection, type Section } from "@/lib/section";
import { traderApi, type TraderCapabilities } from "@/lib/cactus-api";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  match: string[];
}

const NAVIGATION: NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    match: [
      "/",
      "/portfolio",
      "/ai-brain",
      "/copilot",
      "/autopilot",
      "/execution-health",
      "/restricted-live",
      "/decisions",
      "/journal",
      "/stats",
    ],
  },
  {
    href: "/strategies",
    label: "Strategies",
    icon: Layers3,
    match: ["/builder", "/memory"],
  },
  { href: "/backtest", label: "Backtest Lab", icon: FlaskConical, match: [] },
  { href: "/trades", label: "Activity", icon: Activity, match: [] },
  { href: "/settings", label: "Settings", icon: Settings, match: ["/account"] },
];

const MODE_LABELS: Record<string, string> = {
  research: "Brain",
  copilot: "Co-Pilot",
  autopilot: "AutoPilot",
};

function activeItem(item: NavItem, location: string): boolean {
  if (location === item.href || location.startsWith(`${item.href}/`))
    return true;
  return item.match.some(
    (path) =>
      location === path || (path !== "/" && location.startsWith(`${path}/`)),
  );
}

function ThemeControl() {
  const { theme, setTheme } = useTheme();
  const options = [
    { id: "dark", label: "Dark", icon: Moon },
    { id: "light", label: "Light", icon: Sun },
    { id: "system", label: "System", icon: Monitor },
  ] as const;
  return (
    <div
      className="grid grid-cols-3 gap-1 rounded-lg border border-border/60 bg-muted/40 p-1"
      role="group"
      aria-label="Appearance theme"
    >
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            aria-label={`${option.label} theme`}
            aria-pressed={theme === option.id}
            onClick={() => setTheme(option.id)}
            className={cn(
              "grid min-h-9 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground",
              theme === option.id && "bg-background text-primary shadow-sm",
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}

function Sidebar({
  location,
  adminEnabled,
  accountName,
  onLogout,
}: {
  location: string;
  adminEnabled: boolean;
  accountName: string;
  onLogout: () => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto px-3 py-5">
      <div className="px-3 pb-8 pt-1">
        <Link
          href="/dashboard"
          className="inline-flex rounded-md"
          aria-label="Cactus AI home"
        >
          <CactusLogo size="lg" />
        </Link>
      </div>
      <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Workspace
      </p>
      <nav className="space-y-1" aria-label="Trader workspace">
        {NAVIGATION.map((item) => {
          const Icon = item.icon;
          const active = activeItem(item, location);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex min-h-11 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
              <span>{item.label}</span>
              {active && (
                <span
                  className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-primary"
                  aria-hidden="true"
                />
              )}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto space-y-4 pt-8">
        <ThemeControl />
        <div className="space-y-1 border-t border-border/60 pt-4">
          <Link
            href="/settings?view=profile"
            className="flex min-h-14 items-center gap-2.5 rounded-lg px-2 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border/70 bg-muted/60">
              <UserCircle2 className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-foreground">
                {accountName}
              </span>
              <span className="mt-0.5 block text-[11px]">
                Profile &amp; security
              </span>
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </Link>
          {adminEnabled && (
            <a
              href="/admin/"
              className="flex min-h-10 items-center gap-2.5 rounded-md px-3 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Open Admin
              Console
            </a>
          )}
          <button
            type="button"
            onClick={onLogout}
            className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-3 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" /> Log out
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionControl({ onSetUp }: { onSetUp: (section: Section) => void }) {
  const { section, setSection } = useSection();
  const sections = useGetSections({
    query: { queryKey: getGetSectionsQueryKey() },
  });
  const activated = sections.data?.activated?.length
    ? sections.data.activated
    : [section];
  return (
    <div
      className="flex shrink-0 rounded-lg border border-border/60 bg-muted/40 p-1"
      role="group"
      aria-label="Market mode"
    >
      {[
        { id: "crypto" as const, label: "Crypto", icon: Bitcoin },
        { id: "forex" as const, label: "Forex", icon: CandlestickChart },
      ].map((item) => {
        const Icon = item.icon;
        const configured = activated.includes(item.id);
        const active = section === item.id && configured;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            onClick={() =>
              configured ? setSection(item.id) : onSetUp(item.id)
            }
            className={cn(
              "flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
              active
                ? "bg-surface text-primary shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {configured ? (
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

interface WorkspaceConfig {
  executionTarget?: string;
  testnet?: boolean;
  broker?: string;
  mode?: string;
}

function EnvironmentContext({
  config,
}: {
  config: WorkspaceConfig | undefined;
}) {
  const isDemo = config?.executionTarget === "demo";
  const isLive = config?.executionTarget === "live" && config.testnet === false;
  const isPractice =
    config?.executionTarget === "live" && config.testnet === true;
  const broker =
    config?.broker === "oanda"
      ? "OANDA"
      : config?.broker === "binance"
        ? "Binance"
        : null;
  const label = isDemo
    ? "Cactus Demo"
    : isLive
      ? `${broker ? `${broker} ` : ""}Live — real funds`
      : isPractice && broker
        ? `${broker} ${config?.broker === "oanda" ? "Practice" : "Testnet"}`
        : "Environment unknown";
  const executionLabel = isDemo
    ? "Simulated execution"
    : isLive
      ? "Real-money execution"
      : isPractice
        ? "Practice execution"
        : "Execution unavailable";
  return (
    <Link
      href="/settings?view=connections"
      className="group min-w-0 rounded-md"
      aria-label={`Manage account and connections: ${label}, ${executionLabel}`}
    >
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold leading-4",
          isDemo
            ? "border-demo/20 bg-demo/8 text-demo"
            : isLive
              ? "border-live/40 bg-live/10 text-live"
              : isPractice
                ? "border-practice/30 bg-practice/10 text-practice"
                : "border-border bg-muted/40 text-muted-foreground",
        )}
      >
        <span>{label}</span>
        <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
      </span>
      <span className="mt-1 block text-[10px] text-muted-foreground group-hover:text-foreground">
        {executionLabel}
      </span>
    </Link>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { section, setSection } = useSection();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingUp, setSettingUp] = useState<{
    target: Section;
    previous: Section;
  } | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const accountQuery = useAccount();
  const isDemoAccount = accountQuery.data?.isDemo ?? false;
  const accountName =
    accountQuery.data?.displayName ||
    accountQuery.data?.username ||
    "Your account";
  const configQuery = useGetConfig({
    query: { queryKey: getGetConfigQueryKey() },
  });
  const botQuery = useGetBotStatus({
    query: { refetchInterval: 5_000, queryKey: getGetBotStatusQueryKey() },
  });
  const config = configQuery.data as WorkspaceConfig | undefined;
  const executionHealth = useGetExecutionHealth({
    query: {
      enabled: config?.executionTarget === "live",
      refetchInterval: 5_000,
      queryKey: getGetExecutionHealthQueryKey(),
    },
  });
  const capabilitiesQuery = useQuery({
    queryKey: ["trader-capabilities", section],
    queryFn: () => traderApi<TraderCapabilities>("/capabilities"),
    staleTime: 30_000,
  });

  const currentNav = useMemo(
    () => NAVIGATION.find((item) => activeItem(item, location)),
    [location],
  );
  useEffect(() => {
    setMobileOpen(false);
    document.title = `${currentNav?.label ?? "Cactus AI"} · Cactus AI`;
    requestAnimationFrame(() =>
      mainRef.current?.focus({ preventScroll: true }),
    );
  }, [currentNav?.label, location]);

  async function logout() {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    window.location.reload();
  }

  if (settingUp) {
    return (
      <OnboardingWizard
        presetMarket={settingUp.target}
        onDone={(completed) => {
          if (!completed) setSection(settingUp.previous);
          setSettingUp(null);
          void queryClient.invalidateQueries({
            queryKey: getGetSectionsQueryKey(),
          });
        }}
      />
    );
  }

  const sidebar = (
    <Sidebar
      location={location}
      adminEnabled={capabilitiesQuery.data?.features?.adminConsole === true}
      accountName={accountName}
      onLogout={logout}
    />
  );
  const executionEnvironmentLabel =
    config?.testnet === true
      ? config.broker === "oanda"
        ? "OANDA PRACTICE — VIRTUAL FUNDS"
        : "BINANCE TESTNET — TEST FUNDS"
      : config?.testnet === false
        ? "LIVE — REAL FUNDS"
        : "BROKER ENVIRONMENT UNKNOWN";
  const liveUnknown =
    config?.executionTarget === "live" &&
    (executionHealth.isError || !executionHealth.data);
  const liveBlocked =
    config?.executionTarget === "live" &&
    executionHealth.data?.status !== "HEALTHY";

  return (
    <div className="flex min-h-[100dvh] bg-background text-foreground">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:translate-y-0"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-[100dvh] w-[220px] shrink-0 border-r border-border/60 bg-surface md:block">
        {sidebar}
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-40 border-b border-border/60 bg-surface/95 backdrop-blur">
          <div className="flex min-h-[76px] flex-wrap items-center gap-x-3 gap-y-3 px-3 py-3 sm:px-5 lg:gap-x-6 lg:px-7">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted md:hidden"
                aria-label="Open navigation"
                aria-expanded={mobileOpen}
                aria-controls="mobile-navigation"
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
              </button>
              <div className="min-w-0">
                <nav
                  aria-label="Breadcrumb"
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="hidden text-muted-foreground xl:inline">
                    Workspace
                  </span>
                  <ChevronRight
                    className="hidden h-3 w-3 text-muted-foreground xl:block"
                    aria-hidden="true"
                  />
                  <span
                    className="truncate font-semibold text-foreground"
                    aria-current="page"
                  >
                    {currentNav?.label ?? "Cactus AI"}
                  </span>
                </nav>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {MODE_LABELS[config?.mode ?? ""]
                    ? `${MODE_LABELS[config?.mode ?? ""]} selected`
                    : "Mode unavailable"}
                </p>
              </div>
            </div>
            <div className="order-3 flex w-full min-w-0 items-center justify-between gap-3 border-t border-border/50 pt-3 lg:order-none lg:w-auto lg:gap-6 lg:border-0 lg:pt-0">
              <EnvironmentContext config={config} />
              <SectionControl
                onSetUp={(target) =>
                  setSettingUp({ target, previous: section })
                }
              />
            </div>
            <div className="order-2 flex shrink-0 items-center gap-2 lg:order-none lg:border-l lg:border-border/60 lg:pl-5">
              <div className="grid h-10 w-10 place-items-center rounded-lg hover:bg-muted/50">
                <NotificationBell />
              </div>
              <Link
                href="/settings?view=profile"
                className="grid h-9 w-9 place-items-center rounded-full border border-border/70 bg-muted/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={`Profile and security for ${accountName}`}
              >
                <UserCircle2 className="h-5 w-5" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </header>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            id="mobile-navigation"
            side="left"
            className="w-[min(18rem,calc(100vw-2rem))] bg-surface p-0 md:hidden"
            aria-describedby={undefined}
          >
            <SheetTitle className="sr-only">Trader navigation</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>

        {config?.executionTarget === "live" && (
          <Link
            href="/execution-health"
            role="alert"
            className={cn(
              "flex items-center justify-center gap-2 border-b px-4 py-2.5 text-center text-xs font-semibold",
              liveUnknown || liveBlocked
                ? "border-destructive/50 bg-destructive/10 text-destructive"
                : "border-live/40 bg-live/10 text-live",
            )}
          >
            {liveUnknown || liveBlocked ? (
              <ShieldAlert className="h-4 w-4 shrink-0" />
            ) : (
              <ShieldCheck className="h-4 w-4 shrink-0" />
            )}
            {liveUnknown
              ? `${executionEnvironmentLabel} · execution authority is unknown and must be treated as blocked`
              : `${executionEnvironmentLabel} · Execution ${executionHealth.data?.status ?? "UNKNOWN"} · authority ${executionHealth.data?.operatingMode ?? "UNKNOWN"}/${executionHealth.data?.operatingModeSource ?? "UNKNOWN"}`}
          </Link>
        )}
        {isDemoAccount && (
          <div className="border-b border-demo/30 bg-demo/10 px-4 py-2 text-center text-xs">
            <strong className="text-demo">
              Cactus Demo account · read-only
            </strong>
            <span className="text-muted-foreground">
              {" "}
              — controls are disabled for the shared snapshot.
            </span>
          </div>
        )}
        {botQuery.data?.circuitBreakerActive && (
          <div
            className="flex items-center justify-center gap-2 border-b border-destructive/50 bg-destructive/10 px-4 py-2.5 text-center text-xs font-semibold text-destructive"
            role="alert"
          >
            <ShieldAlert className="h-4 w-4" /> Risk circuit breaker engaged.
            New entries are halted; existing positions remain managed.
          </div>
        )}
        {botQuery.data?.running &&
          !botQuery.data.newEntriesAllowed &&
          !botQuery.data.circuitBreakerActive && (
            <div
              className="flex items-center justify-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2.5 text-center text-xs font-semibold text-warning"
              role="alert"
            >
              <ShieldAlert className="h-4 w-4" />{" "}
              {botQuery.data.entryBlockReason ?? "New entries are blocked."}{" "}
              Protective management continues.
            </div>
          )}

        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="min-w-0 p-3 outline-none sm:p-5 lg:px-7 lg:py-6"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

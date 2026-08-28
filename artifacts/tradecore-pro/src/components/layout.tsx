import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useTheme } from "next-themes";
import {
  Bitcoin,
  CandlestickChart,
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
import { useIsDemo } from "@/lib/account";
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
    match: ["/", "/portfolio", "/trades", "/ai-brain", "/copilot", "/autopilot", "/execution-health", "/restricted-live", "/decisions", "/journal", "/stats"],
  },
  { href: "/strategies", label: "Strategies", icon: Layers3, match: ["/builder", "/memory"] },
  { href: "/backtest", label: "Backtest Lab", icon: FlaskConical, match: [] },
  { href: "/settings", label: "Settings", icon: Settings, match: ["/account"] },
];

const MODE_LABELS: Record<string, string> = {
  research: "Brain",
  copilot: "Co-Pilot",
  autopilot: "AutoPilot",
};

function activeItem(item: NavItem, location: string): boolean {
  if (location === item.href || location.startsWith(`${item.href}/`)) return true;
  return item.match.some((path) => location === path || (path !== "/" && location.startsWith(`${path}/`)));
}

function ThemeControl() {
  const { theme, setTheme } = useTheme();
  const options = [
    { id: "dark", label: "Dark", icon: Moon },
    { id: "light", label: "Light", icon: Sun },
    { id: "system", label: "System", icon: Monitor },
  ] as const;
  return (
    <div className="grid grid-cols-3 gap-1 rounded-lg border bg-muted/20 p-1" aria-label="Appearance theme">
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            aria-label={`${option.label} theme`}
            aria-pressed={theme === option.id}
            onClick={() => setTheme(option.id)}
            className={cn("grid min-h-9 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground", theme === option.id && "bg-background text-primary shadow-sm")}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}

function Sidebar({ location, adminEnabled, onLogout }: { location: string; adminEnabled: boolean; onLogout: () => void }) {
  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex items-center gap-3 px-2 pb-6 pt-1">
        <CactusLogo size="lg" />
        <span className="rounded border border-primary/30 bg-primary/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-primary">Trader</span>
      </div>
      <nav className="space-y-1" aria-label="Trader workspace">
        {NAVIGATION.map((item) => {
          const Icon = item.icon;
          const active = activeItem(item, location);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn("flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors", active ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}
            >
              <Icon className="h-4 w-4" /> {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto space-y-3 pt-8">
        <ThemeControl />
        <div className="rounded-lg border bg-muted/15 p-2">
          <Link href="/settings?view=profile" className="flex min-h-10 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"><UserCircle2 className="h-4 w-4" /> Profile &amp; security</Link>
          {adminEnabled && <a href="/admin/" className="flex min-h-10 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"><ShieldCheck className="h-4 w-4" /> Open Admin Console</a>}
          <button type="button" onClick={onLogout} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"><LogOut className="h-4 w-4" /> Log out</button>
        </div>
      </div>
    </div>
  );
}

function SectionControl({ onSetUp }: { onSetUp: (section: Section) => void }) {
  const { section, setSection } = useSection();
  const sections = useGetSections({ query: { queryKey: getGetSectionsQueryKey() } });
  const activated = sections.data?.activated?.length ? sections.data.activated : [section];
  return (
    <div className="flex rounded-lg border bg-background p-1" aria-label="Market mode">
      {([
        { id: "crypto" as const, label: "Crypto", icon: Bitcoin },
        { id: "forex" as const, label: "Forex", icon: CandlestickChart },
      ]).map((item) => {
        const Icon = item.icon;
        const configured = activated.includes(item.id);
        const active = section === item.id && configured;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            onClick={() => configured ? setSection(item.id) : onSetUp(item.id)}
            className={cn("flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium", active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {configured ? <Icon className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}{item.label}
          </button>
        );
      })}
    </div>
  );
}

function EnvironmentBadge({ config }: { config: { executionTarget?: string; testnet?: boolean; broker?: string; mode?: string } | undefined }) {
  if (!config) return <span className="rounded border px-2 py-1 text-[10px] text-muted-foreground">ENVIRONMENT UNKNOWN</span>;
  const isDemo = config.executionTarget === "demo";
  const isLive = !isDemo && !config.testnet;
  const label = isDemo
    ? "CACTUS DEMO"
    : config.broker === "oanda"
      ? config.testnet ? "OANDA PRACTICE" : "OANDA LIVE — REAL FUNDS"
      : config.testnet ? "BINANCE TESTNET" : "BINANCE LIVE — REAL FUNDS";
  return <span className={cn("rounded border px-2 py-1 text-[10px] font-bold tracking-[0.08em]", isDemo ? "border-demo/40 bg-demo/10 text-demo" : isLive ? "border-live/50 bg-live/12 text-live" : "border-practice/40 bg-practice/10 text-practice")}>{label}</span>;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { section, setSection } = useSection();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingUp, setSettingUp] = useState<{ target: Section; previous: Section } | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const isDemoAccount = useIsDemo();
  const configQuery = useGetConfig({ query: { queryKey: getGetConfigQueryKey() } });
  const botQuery = useGetBotStatus({ query: { refetchInterval: 5_000, queryKey: getGetBotStatusQueryKey() } });
  const config = configQuery.data as undefined | { executionTarget?: string; testnet?: boolean; broker?: string; mode?: string };
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

  const currentNav = useMemo(() => NAVIGATION.find((item) => activeItem(item, location)), [location]);
  useEffect(() => {
    setMobileOpen(false);
    document.title = `${currentNav?.label ?? "Cactus AI"} · Cactus AI`;
    requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
  }, [currentNav?.label, location]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.reload();
  }

  if (settingUp) {
    return <OnboardingWizard presetMarket={settingUp.target} onDone={(completed) => {
      if (!completed) setSection(settingUp.previous);
      setSettingUp(null);
      void queryClient.invalidateQueries({ queryKey: getGetSectionsQueryKey() });
    }} />;
  }

  const sidebar = <Sidebar location={location} adminEnabled={capabilitiesQuery.data?.features?.adminConsole === true} onLogout={logout} />;
  const liveUnknown = config?.executionTarget === "live" && (executionHealth.isError || !executionHealth.data);
  const liveBlocked = config?.executionTarget === "live" && executionHealth.data?.status !== "HEALTHY";

  return (
    <div className="flex min-h-[100dvh] bg-background text-foreground">
      <a href="#main-content" className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:translate-y-0">Skip to content</a>
      <aside className="hidden w-64 shrink-0 border-r bg-surface md:block">{sidebar}</aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-40 border-b bg-surface/95 backdrop-blur">
          <div className="flex min-h-16 items-center gap-3 px-3 sm:px-4 lg:px-6">
            <button type="button" onClick={() => setMobileOpen(true)} className="grid h-11 w-11 place-items-center rounded-lg text-muted-foreground hover:bg-muted md:hidden" aria-label="Open navigation"><Menu className="h-5 w-5" /></button>
            <div className="md:hidden"><CactusLogo /></div>
            <div className="hidden md:block"><SectionControl onSetUp={(target) => setSettingUp({ target, previous: section })} /></div>
            <div className="h-6 w-px bg-border" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-2">
              <EnvironmentBadge config={config} />
              <Link href="/settings?view=connections" className="whitespace-nowrap rounded border px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:text-foreground">ACCOUNT · {config?.executionTarget === "demo" ? "Cactus Demo" : config?.broker === "oanda" ? "OANDA" : "Binance"}</Link>
              <span className="whitespace-nowrap rounded border px-2 py-1 text-[10px] font-semibold text-muted-foreground">MODE · {MODE_LABELS[config?.mode ?? ""] ?? "UNKNOWN"}</span>
              <span className="whitespace-nowrap rounded border px-2 py-1 text-[10px] font-semibold text-muted-foreground md:hidden">{section.toUpperCase()}</span>
            </div>
            <NotificationBell />
          </div>
        </header>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-[18rem] p-0 md:hidden"><SheetTitle className="sr-only">Trader navigation</SheetTitle>{sidebar}</SheetContent>
        </Sheet>

        {config?.executionTarget === "live" && (
          <Link href="/execution-health" role="alert" className={cn("flex items-center justify-center gap-2 border-b px-4 py-2.5 text-center text-xs font-semibold", liveUnknown || liveBlocked ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-live/40 bg-live/10 text-live")}>
            {liveUnknown || liveBlocked ? <ShieldAlert className="h-4 w-4 shrink-0" /> : <ShieldCheck className="h-4 w-4 shrink-0" />}
            {liveUnknown
              ? "LIVE — REAL FUNDS · execution authority is unknown and must be treated as blocked"
              : `LIVE — REAL FUNDS · Live ${executionHealth.data?.status ?? "UNKNOWN"} · authority ${executionHealth.data?.operatingMode ?? "UNKNOWN"}/${executionHealth.data?.operatingModeSource ?? "UNKNOWN"}`}
          </Link>
        )}
        {isDemoAccount && <div className="border-b border-demo/30 bg-demo/10 px-4 py-2 text-center text-xs"><strong className="text-demo">Cactus Demo account · read-only</strong><span className="text-muted-foreground"> — controls are disabled for the shared snapshot.</span></div>}
        {botQuery.data?.circuitBreakerActive && <div className="flex items-center justify-center gap-2 border-b border-destructive/50 bg-destructive/10 px-4 py-2.5 text-center text-xs font-semibold text-destructive" role="alert"><ShieldAlert className="h-4 w-4" /> Risk circuit breaker engaged. New entries are halted; existing positions remain managed.</div>}
        {botQuery.data?.running && !botQuery.data.newEntriesAllowed && !botQuery.data.circuitBreakerActive && <div className="flex items-center justify-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2.5 text-center text-xs font-semibold text-warning" role="alert"><ShieldAlert className="h-4 w-4" /> {botQuery.data.entryBlockReason ?? "New entries are blocked."} Protective management continues.</div>}

        <main id="main-content" ref={mainRef} tabIndex={-1} className="min-w-0 p-3 outline-none sm:p-5 lg:p-6">{children}</main>
      </div>
    </div>
  );
}

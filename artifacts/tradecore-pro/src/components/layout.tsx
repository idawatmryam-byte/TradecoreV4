import { Link, useLocation } from "wouter";
import {
  Activity, BarChart2, BrainCircuit, FlaskConical, History, Settings, ShieldAlert,
  Layers, LogOut, Menu, UserCircle2, Bitcoin, CandlestickChart, Eye, Hammer, Inbox,
  ChevronDown, Plus,
} from "lucide-react";
import { useGetBotStatus, useHealthCheck, useGetConfig, useGetSections, getGetBotStatusQueryKey, getHealthCheckQueryKey, getGetConfigQueryKey, getGetSectionsQueryKey } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import { useSection, type Section } from "@/lib/section";
import { useIsDemo } from "@/lib/account";
import { NotificationBell } from "@/components/notification-bell";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { MODE_LABELS } from "@/components/mode-picker";
import { CactusLogo } from "@/components/cactus-logo";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { useQueryClient } from "@tanstack/react-query";

const SECTION_LABELS: Record<Section, string> = { crypto: "Crypto", forex: "Forex" };

/**
 * The one place a user can look to answer "am I trading with real money right
 * now?" without opening Settings. Reads the same `config` query `Layout`
 * already fetches for the sidebar Mode row — no extra request. Green/Demo,
 * amber/Live per the founder's spec; the subtitle names the market and mode
 * so the badge stays meaningful once a user has more than one section set up.
 */
function ExecutionBadge({
  executionTarget,
  mode,
  section,
  compact = false,
}: {
  executionTarget?: "demo" | "live";
  mode?: string;
  section: Section;
  /** Mobile top bar has little room — pill only, no subtitle line. */
  compact?: boolean;
}) {
  if (!executionTarget) return null;
  const isLive = executionTarget === "live";
  const pill = (
    <Badge variant={isLive ? "warning" : "success"} className="gap-1.5 whitespace-nowrap">
      <span className={cn("h-1.5 w-1.5 rounded-full", isLive ? "bg-warning" : "bg-success")} />
      {compact ? (isLive ? "Live" : "Demo") : (isLive ? "Live Trading" : "Demo Trading")}
    </Badge>
  );
  if (compact) return pill;
  return (
    <div className="flex flex-col items-start gap-1 leading-none">
      {pill}
      <span className="text-[11px] text-muted-foreground">
        {SECTION_LABELS[section]} {isLive ? "Live" : "Demo"} · {MODE_LABELS[mode ?? ""] ?? "—"}
      </span>
    </div>
  );
}

const SECTION_TABS: { id: Section; label: string; icon: typeof Bitcoin }[] = [
  { id: "crypto", label: "Crypto", icon: Bitcoin },
  { id: "forex", label: "Forex", icon: CandlestickChart },
];

/**
 * Crypto / Forex.
 *
 * Sits above the nav rather than inside it because it scopes everything below
 * it: the two sections are fully independent engines with their own positions,
 * strategies and trade logs, so this is not a filter — it is which product you
 * are looking at.
 *
 * A market the user has not set up is shown but NOT presented as a peer of one
 * they have. Onboarding asks them to choose a single market on purpose; two
 * identical tabs immediately afterwards made that choice look decorative, and
 * tapping the other one silently dropped them into an unconfigured section.
 * It now reads as an offer and routes into Add Market, so the choice visibly
 * means something and the second market is still one tap away.
 */
function SectionSwitcher({ onSetUp }: { onSetUp: (section: Section) => void }) {
  const { section, setSection } = useSection();
  const { data } = useGetSections({ query: { queryKey: getGetSectionsQueryKey() } });

  // An empty list means a brand-new account that skipped onboarding — fall
  // back to whatever they are looking at rather than offering to set up the
  // section they are currently using.
  const activated = data?.activated?.length ? data.activated : [section];

  return (
    <div className="mb-6">
      <div className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/40 p-1">
        {SECTION_TABS.map((tab) => {
          const Icon = tab.icon;
          const isSetUp = activated.includes(tab.id);
          const isActive = section === tab.id && isSetUp;
          return (
            <button
              key={tab.id}
              onClick={() => (isSetUp ? setSection(tab.id) : onSetUp(tab.id))}
              aria-pressed={isActive}
              title={isSetUp ? undefined : `Set up ${tab.label} trading`}
              className={cn(
                "flex min-h-9 items-center justify-center gap-2 rounded-md px-2 text-sm font-medium transition-colors",
                isActive && "bg-background text-foreground shadow-sm",
                !isActive && isSetUp && "text-muted-foreground hover:text-foreground",
                !isSetUp && "text-muted-foreground/60 hover:text-foreground",
              )}
            >
              {isSetUp ? <Icon className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface NavItem {
  href: string;
  label: string;
  icon: typeof Activity;
  /** Routes that should also light this item up, e.g. its detail pages or tabs. */
  match?: string[];
}

/**
 * Five everyday destinations.
 *
 * The nav used to list all twelve pages flat, which made a first-time user
 * choose between "Decisions", "Journal" and "Analytics" before knowing what
 * any of them meant. Related pages are now reached as tabs within a
 * destination — `match` keeps the parent highlighted while you are on one —
 * and the engineering tools move to the Advanced group below.
 *
 * Routes are unchanged; this is grouping, not a rename of anything addressable.
 */
const PRIMARY_NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: Activity },
  { href: "/copilot", label: "AI Co-Pilot", icon: Inbox },
  { href: "/trades", label: "Portfolio", icon: History, match: ["/journal"] },
  { href: "/stats", label: "Performance", icon: BarChart2, match: ["/decisions"] },
  { href: "/settings", label: "Settings", icon: Settings, match: ["/account"] },
];

/**
 * Everything that assumes you already know what the engine does.
 *
 * Collapsed by default for everyone — statically, not keyed to account age or
 * trade count. A nav that rearranges itself as you use it is disorienting, and
 * nothing here is hidden or locked: one tap opens it.
 */
const ADVANCED_NAV: NavItem[] = [
  { href: "/strategies", label: "Strategies", icon: Layers },
  { href: "/builder", label: "Strategy Builder", icon: Hammer },
  { href: "/backtest", label: "Backtesting", icon: FlaskConical },
  { href: "/memory", label: "Learning", icon: BrainCircuit },
];

/** Does `location` belong to this nav item? */
function isItemActive(item: NavItem, location: string): boolean {
  if (item.href === "/") return location === "/";
  // Prefix match, so a detail route (/copilot/42) keeps its parent lit —
  // exact matching left the workspace page with no highlighted nav item.
  if (location === item.href || location.startsWith(`${item.href}/`)) return true;
  return (item.match ?? []).some((m) => location === m || location.startsWith(`${m}/`));
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", active && "text-primary")} />
      {item.label}
    </Link>
  );
}

/** The sidebar body — one definition, rendered into both the desktop rail and the mobile sheet. */
function NavBody({
  location,
  online,
  mode,
  onLogout,
  onSetUpSection,
}: {
  location: string;
  online: boolean;
  mode: string;
  onLogout: () => void;
  onSetUpSection: (section: Section) => void;
}) {
  const advancedActive = ADVANCED_NAV.some((i) => isItemActive(i, location));
  const [advancedOpen, setAdvancedOpen] = useState(advancedActive);

  // Opening an Advanced page directly (a bookmark, a deep link) should reveal
  // where you are rather than leaving the group shut over a highlighted item.
  useEffect(() => {
    if (advancedActive) setAdvancedOpen(true);
  }, [advancedActive]);

  return (
    <div className="flex h-full flex-col p-4">
      <SectionSwitcher onSetUp={onSetUpSection} />

      <nav className="space-y-1">
        {PRIMARY_NAV.map((item) => (
          <NavLink key={item.href} item={item} active={isItemActive(item, location)} />
        ))}
      </nav>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-6">
        <CollapsibleTrigger
          className={cn(
            "flex min-h-11 w-full items-center justify-between rounded-md px-3 text-sm font-medium transition-colors",
            "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <span>Advanced</span>
          <ChevronDown className={cn("h-4 w-4 transition-transform", advancedOpen && "rotate-180")} />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1 space-y-1">
          {ADVANCED_NAV.map((item) => (
            <NavLink key={item.href} item={item} active={isItemActive(item, location)} />
          ))}
        </CollapsibleContent>
      </Collapsible>

      {/* mt-auto now works: this container is a flex column with a height.
          It previously sat inside a plain div, so the status block never
          reached the bottom of the rail it was written to pin to. */}
      <div className="mt-auto pt-6">
        <div className="rounded-lg border bg-card p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Engine</span>
            <span className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                {online && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                )}
                <span className={cn("relative inline-flex h-2 w-2 rounded-full", online ? "bg-success" : "bg-muted-foreground")} />
              </span>
              <span className={cn("text-sm font-medium tabular-nums", online ? "text-success" : "text-muted-foreground")}>
                {online ? "Running" : "Stopped"}
              </span>
            </span>
          </div>
          {/* Who decides — NOT the exchange environment.
              This row used to show botStatus.mode ("testnet" / "live"), which
              is a different thing entirely and collided with the mode a user
              actually chooses. Showing the decision mode here is both more
              useful and the thing they are looking for; demo vs live is
              already unmistakable from the balance and the banners. */}
          <div className="mt-2 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Mode</span>
            <Link href="/settings" className="text-sm font-medium capitalize hover:text-primary">
              {mode}
            </Link>
          </div>
        </div>

        <button
          onClick={onLogout}
          className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
          Log out
        </button>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isDemo = useIsDemo();
  const { section, setSection } = useSection();
  const { data: botStatus } = useGetBotStatus({
    query: { refetchInterval: 5000, queryKey: getGetBotStatusQueryKey() }
  });
  const { data: health, isError: healthError } = useHealthCheck({
    query: { refetchInterval: 15000, queryKey: getHealthCheckQueryKey() }
  });
  const { data: config } = useGetConfig({ query: { queryKey: getGetConfigQueryKey() } });
  const queryClient = useQueryClient();
  void health;

  // Close the drawer after navigating so it never lingers over the page.
  useEffect(() => { setMobileOpen(false); }, [location]);

  const online = Boolean(botStatus?.running) && !healthError;
  const mode = healthError ? "API error" : (MODE_LABELS[config?.mode ?? ""] ?? "—");

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.reload();
  }

  // Setting up the other market runs the onboarding wizard with its market
  // question skipped — the same flow Settings → Add Market opens, so there is
  // one path to maintain and the user meets the questions they already know.
  const [settingUp, setSettingUp] = useState<{ target: Section; previous: Section } | null>(null);

  const navBody = (
    <NavBody
      location={location}
      online={online}
      mode={mode}
      onLogout={handleLogout}
      onSetUpSection={(target) => setSettingUp({ target, previous: section })}
    />
  );

  if (settingUp) {
    return (
      <OnboardingWizard
        presetMarket={settingUp.target}
        onDone={(completed) => {
          // The wizard has to make its target the active section to write to it
          // at all (every call is X-Section scoped). If the user backed out,
          // that switch has to be undone — otherwise declining to set Forex up
          // leaves the whole app sitting in Forex.
          if (!completed) setSection(settingUp.previous);
          setSettingUp(null);
          // The config write is what marks a section set up, so the switcher
          // must re-read rather than keep offering one that now exists.
          void queryClient.invalidateQueries({ queryKey: getGetSectionsQueryKey() });
        }}
      />
    );
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground md:flex-row">
      {/* Mobile top bar */}
      <header className="relative sticky top-0 z-30 flex items-center justify-between overflow-hidden border-b bg-surface px-4 py-3 md:hidden">
        <div className="ambient-glow" />
        <div className="relative z-10 flex min-w-0 items-center gap-2.5">
          <CactusLogo />
          <ExecutionBadge executionTarget={config?.executionTarget} mode={config?.mode} section={section} compact />
        </div>
        <div className="relative z-10 flex items-center gap-2">
          <NotificationBell />
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* Mobile drawer. Previously the same <aside> toggled by a class swap, so
          it was an in-flow block that pushed the page down — no overlay, no
          backdrop, no focus trap, no escape-to-close. Sheet gives all four. */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[17rem] p-0 md:hidden">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex h-full flex-col overflow-y-auto pt-10">{navBody}</div>
        </SheetContent>
      </Sheet>

      {/* Desktop rail */}
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-surface md:flex">
        <div className="relative overflow-hidden border-b p-5">
          <div className="ambient-glow" />
          <div className="relative z-10 flex items-center gap-3">
            <CactusLogo size="lg" />
            <div className="ml-auto">
              <NotificationBell />
            </div>
          </div>
          <div className="relative z-10 mt-3">
            <ExecutionBadge executionTarget={config?.executionTarget} mode={config?.mode} section={section} />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">{navBody}</div>
      </aside>

      <main className="relative flex flex-1 flex-col overflow-hidden">
        {isDemo && (
          <div className="flex items-center justify-center gap-2.5 border-b border-primary/40 bg-primary/10 px-4 py-2.5 text-xs font-medium text-primary sm:text-sm">
            <Eye className="h-4 w-4 shrink-0" />
            <span>
              <span className="font-semibold">Demo · read-only</span>
              <span className="text-muted-foreground"> — a fully-loaded snapshot. Controls are disabled; </span>
              <button
                type="button"
                className="underline hover:text-primary/80"
                onClick={async () => {
                  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
                  window.location.href = `${window.location.pathname}?signup=1`;
                }}
              >
                create a free account
              </button>
              <span className="text-muted-foreground"> to connect your own keys and trade.</span>
            </span>
          </div>
        )}
        {botStatus?.circuitBreakerActive && (
          <div className="flex items-center justify-center gap-3 border-b border-destructive bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
            <ShieldAlert className="h-5 w-5 shrink-0" />
            <span>
              Circuit breaker engaged — the daily loss limit was reached. New entries are
              halted; existing positions are still monitored.
            </span>
          </div>
        )}
        <div className="flex-1 overflow-auto p-4 sm:p-6 md:p-8">{children}</div>
      </main>
    </div>
  );
}

import { Link, useLocation } from "wouter";
import { Activity, BarChart2, BrainCircuit, FlaskConical, History, Settings, ShieldAlert, Layers, LogOut, Menu, X, UserCircle2, Scale, Bitcoin, CandlestickChart, Eye } from "lucide-react";
import { useGetBotStatus, useHealthCheck, getGetBotStatusQueryKey, getHealthCheckQueryKey } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import { useSection, type Section } from "@/lib/section";
import { useIsDemo } from "@/lib/account";

const SECTION_TABS: { id: Section; label: string; icon: typeof Bitcoin }[] = [
  { id: "crypto", label: "Crypto", icon: Bitcoin },
  { id: "forex", label: "Forex", icon: CandlestickChart },
];

function SectionSwitcher() {
  const { section, setSection } = useSection();
  return (
    <div className="mb-5">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-widest px-2 mb-2">Market</div>
      <div className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-muted/50 border">
        {SECTION_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = section === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setSection(tab.id)}
              className={cn(
                "flex items-center justify-center gap-1.5 px-2 py-2 rounded-md text-xs font-semibold uppercase tracking-wide transition-all",
                isActive
                  ? "bg-primary/15 text-primary shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>
      {section === "forex" && (
        <p className="mt-2 px-2 text-[11px] leading-tight text-muted-foreground">
          Forex section — connect an OANDA account in Account &amp; Safety to start trading.
        </p>
      )}
    </div>
  );
}

const NAV_ITEMS = [
  { href: "/account", label: "Account", icon: UserCircle2 },
  { href: "/", label: "Cockpit", icon: Activity },
  { href: "/trades", label: "Trade Log", icon: History },
  { href: "/decisions", label: "Decisions", icon: Scale },
  { href: "/stats", label: "Analytics", icon: BarChart2 },
  { href: "/strategies", label: "Strategies", icon: Layers },
  { href: "/memory", label: "Memory Core", icon: BrainCircuit },
  { href: "/backtest", label: "Backtesting", icon: FlaskConical },
  { href: "/settings", label: "Account & Safety", icon: Settings },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isDemo = useIsDemo();
  const { data: botStatus } = useGetBotStatus({
    query: { refetchInterval: 5000, queryKey: getGetBotStatusQueryKey() }
  });
  const { data: health, isError: healthError } = useHealthCheck({
    query: { refetchInterval: 15000, queryKey: getHealthCheckQueryKey() }
  });

  // Auto-close the mobile drawer after navigating so it never lingers over the page.
  useEffect(() => { setMobileOpen(false); }, [location]);

  const online = botStatus?.running && !healthError;

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.reload();
  }

  return (
    <div className="flex min-h-[100dvh] bg-background text-foreground flex-col md:flex-row">
      {/* Mobile top bar — compact brand + status + menu toggle (hidden on desktop) */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between border-b bg-card/70 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded bg-primary/20 flex items-center justify-center border border-primary/50">
            <Activity className="h-4 w-4 text-primary" />
          </div>
          <span className="font-bold tracking-tight leading-none">TradeCore Pro</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={cn("h-2 w-2 rounded-full", online ? "bg-success" : "bg-destructive")} />
          <button
            onClick={() => setMobileOpen((o) => !o)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            className="p-1 -mr-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </header>

      {/* Sidebar (desktop) / collapsible drawer (mobile) */}
      <aside className={cn(
        "w-full md:w-64 border-r bg-card/30 flex-col md:flex",
        mobileOpen ? "flex" : "hidden",
      )}>
        <div className="hidden md:flex p-6 border-b items-center gap-3">
          <div className="h-8 w-8 rounded bg-primary/20 flex items-center justify-center border border-primary/50">
            <Activity className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="font-bold tracking-tight text-lg leading-none">TradeCore Pro</h1>
            <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Algorithmic Engine</span>
          </div>
        </div>

        <div className="p-4 flex-1">
          <SectionSwitcher />
          <div className="mb-6 space-y-1">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-widest px-2 mb-2">Navigation</div>
            {NAV_ITEMS.map((item) => {
              const isActive = location === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-md transition-all text-sm font-medium",
                    isActive 
                      ? "bg-primary/10 text-primary" 
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                >
                  <Icon className={cn("h-4 w-4", isActive ? "text-primary" : "text-muted-foreground")} />
                  {item.label}
                </Link>
              );
            })}
          </div>

          <div className="mt-auto">
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">System Status</div>
              
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Engine</span>
                <div className="flex items-center gap-2">
                  <span className={cn("relative flex h-2 w-2")}>
                    {botStatus?.running && !healthError && (
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                    )}
                    <span className={cn("relative inline-flex rounded-full h-2 w-2", (botStatus?.running && !healthError) ? "bg-success" : "bg-destructive")}></span>
                  </span>
                  <span className={cn("text-xs font-mono uppercase", (botStatus?.running && !healthError) ? "text-success" : "text-destructive")}>
                    {healthError ? "API Error" : botStatus?.running ? "Online" : "Offline"}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Mode</span>
                <span className="text-xs font-mono uppercase text-primary bg-primary/10 px-2 py-0.5 rounded border border-primary/20">
                  {botStatus?.mode || "UNKNOWN"}
                </span>
              </div>
            </div>

            <button
              onClick={handleLogout}
              className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
            >
              <LogOut className="h-3.5 w-3.5" />
              Log out
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {isDemo && (
          <div className="bg-primary/10 border-b border-primary/40 text-primary px-6 py-2.5 flex items-center justify-center gap-2.5 text-xs sm:text-sm font-medium tracking-wide">
            <Eye className="h-4 w-4 shrink-0" />
            <span>
              <span className="font-bold uppercase">Demo · read-only</span>
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
          <div className="bg-destructive/10 border-b border-destructive text-destructive px-6 py-3 flex items-center justify-center gap-3 text-sm font-medium tracking-wide">
            <ShieldAlert className="h-5 w-5" />
            CIRCUIT BREAKER ENGAGED: DAILY LOSS LIMIT REACHED. NEW ENTRIES HALTED — EXISTING POSITIONS STILL MONITORED.
          </div>
        )}
        <div className="flex-1 overflow-auto p-4 sm:p-6 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}

import { Link, useLocation } from "wouter";
import { Activity, BarChart2, BrainCircuit, FlaskConical, History, Settings, ShieldAlert, Layers, LogOut } from "lucide-react";
import { useGetBotStatus, useHealthCheck, getGetBotStatusQueryKey, getHealthCheckQueryKey } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Cockpit", icon: Activity },
  { href: "/trades", label: "Trade Log", icon: History },
  { href: "/stats", label: "Analytics", icon: BarChart2 },
  { href: "/strategies", label: "Strategies", icon: Layers },
  { href: "/memory", label: "Memory Core", icon: BrainCircuit },
  { href: "/backtest", label: "Backtesting", icon: FlaskConical },
  { href: "/settings", label: "Configuration", icon: Settings },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: botStatus } = useGetBotStatus({
    query: { refetchInterval: 5000, queryKey: getGetBotStatusQueryKey() }
  });
  const { data: health, isError: healthError } = useHealthCheck({
    query: { refetchInterval: 15000, queryKey: getHealthCheckQueryKey() }
  });

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.reload();
  }

  return (
    <div className="flex min-h-[100dvh] bg-background text-foreground flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="w-full md:w-64 border-r bg-card/30 flex flex-col">
        <div className="p-6 border-b flex items-center gap-3">
          <div className="h-8 w-8 rounded bg-primary/20 flex items-center justify-center border border-primary/50">
            <Activity className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="font-bold tracking-tight text-lg leading-none">TradeCore Pro</h1>
            <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Algorithmic Engine</span>
          </div>
        </div>

        <div className="p-4 flex-1">
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
        {botStatus?.circuitBreakerActive && (
          <div className="bg-destructive/10 border-b border-destructive text-destructive px-6 py-3 flex items-center justify-center gap-3 text-sm font-medium tracking-wide">
            <ShieldAlert className="h-5 w-5" />
            CIRCUIT BREAKER ENGAGED: DAILY LOSS LIMIT REACHED. NEW ENTRIES HALTED — EXISTING POSITIONS STILL MONITORED.
          </div>
        )}
        <div className="flex-1 overflow-auto p-6 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}

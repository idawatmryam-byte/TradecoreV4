import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { useTheme } from "next-themes";
import { Bell, Monitor, Moon, Palette, Settings as SettingsIcon, Sun } from "lucide-react";
import { Settings } from "@/pages/settings";
import { Account } from "@/pages/account";
import { cn } from "@/lib/utils";

const views = [
  { id: "trading", label: "Trading Preferences" },
  { id: "connections", label: "Connections" },
  { id: "profile", label: "Profile & Security" },
  { id: "appearance", label: "Appearance & Notifications" },
] as const;

function AppearancePanel() {
  const { theme, setTheme } = useTheme();
  const [density, setDensity] = useState(() => localStorage.getItem("cactus.density") ?? "compact");
  const [reduceMotion, setReduceMotion] = useState(() => localStorage.getItem("cactus.reduce-motion") === "true");
  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem("cactus.density", density);
  }, [density]);
  useEffect(() => {
    document.documentElement.dataset.reduceMotion = String(reduceMotion);
    localStorage.setItem("cactus.reduce-motion", String(reduceMotion));
  }, [reduceMotion]);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="terminal-panel p-5"><div className="flex items-center gap-2"><Palette className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">Appearance</h2></div><p className="mt-2 text-xs leading-5 text-muted-foreground">Non-financial display preferences are stored on this device. They never change authority or risk state.</p><div className="mt-5 grid grid-cols-3 gap-2">{([{ id: "dark", label: "Dark", icon: Moon }, { id: "light", label: "Light", icon: Sun }, { id: "system", label: "System", icon: Monitor }] as const).map((item) => { const Icon = item.icon; return <button key={item.id} onClick={() => setTheme(item.id)} aria-pressed={theme === item.id} className={cn("min-h-20 rounded-lg border p-3 text-xs", theme === item.id && "border-primary bg-primary/10 text-primary")}><Icon className="mx-auto mb-2 h-4 w-4" />{item.label}</button>; })}</div><label className="mt-5 block text-xs font-medium">Information density<select value={density} onChange={(event) => setDensity(event.target.value)} className="mt-2 min-h-11 w-full rounded-lg border bg-background px-3"><option value="compact">Compact terminal</option><option value="comfortable">Comfortable</option></select></label><label className="mt-4 flex min-h-11 items-center justify-between gap-3 rounded-lg border p-3 text-xs"><span><strong className="block">Reduce interface motion</strong><span className="mt-1 block text-muted-foreground">Also follows your operating-system preference.</span></span><input type="checkbox" checked={reduceMotion} onChange={(event) => setReduceMotion(event.target.checked)} className="h-5 w-5 accent-primary" /></label></section>
      <section className="terminal-panel p-5"><div className="flex items-center gap-2"><Bell className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">Notifications</h2></div><p className="mt-2 text-xs leading-5 text-muted-foreground">Risk-alert webhook configuration remains under Trading Preferences. Unsupported email and SMS channels are intentionally not shown.</p><div className="mt-5 rounded-lg border bg-muted/20 p-4 text-sm"><strong>In-app critical alerts</strong><p className="mt-1 text-xs leading-5 text-muted-foreground">Risk suspension, stale market data, broker disconnection, and execution failure remain persistent until the authoritative state clears.</p></div></section>
    </div>
  );
}

export function SettingsHub() {
  const search = useSearch();
  const requested = new URLSearchParams(search).get("view");
  const view = views.some((item) => item.id === requested) ? requested! : "trading";
  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
      <header><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">User-owned configuration</p><h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight"><SettingsIcon className="h-5 w-5 text-primary" /> Settings</h1><p className="mt-1 text-sm text-muted-foreground">Profile, security, appearance, trading preferences, and write-only broker connections.</p></header>
      <nav className="flex gap-1 overflow-x-auto rounded-xl border bg-surface p-1" aria-label="Settings sections">{views.map((item) => <Link key={item.id} href={`/settings?view=${item.id}`} aria-current={view === item.id ? "page" : undefined} className={cn("min-h-10 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground", view === item.id && "bg-background text-foreground shadow-sm")}>{item.label}</Link>)}</nav>
      {(view === "trading" || view === "connections") && <Settings />}
      {view === "profile" && <Account />}
      {view === "appearance" && <AppearancePanel />}
    </div>
  );
}

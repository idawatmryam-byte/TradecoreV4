import { Link, useSearch } from "wouter";
import { Layers3 } from "lucide-react";
import { Strategies } from "@/pages/strategies";
import { StrategyBuilder } from "@/pages/strategy-builder";
import { Memory } from "@/pages/memory";
import { StrategyAssignmentMatrix } from "@/components/strategy-assignment-matrix";
import { cn } from "@/lib/utils";

const views = [
  { id: "library", label: "Library & Configuration" },
  { id: "builder", label: "Builder" },
  { id: "assignments", label: "Mode Assignments" },
  { id: "evidence", label: "Performance & Evidence" },
] as const;

export function StrategiesHub() {
  const search = useSearch();
  const requested = new URLSearchParams(search).get("view");
  const view = views.some((item) => item.id === requested) ? requested! : "library";
  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <header>
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Strategy management</p>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight"><Layers3 className="h-5 w-5 text-primary" /> Strategies</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Create, configure, version, assign, and evaluate strategies without exposing internal engine architecture.</p>
      </header>
      <nav className="flex gap-1 overflow-x-auto rounded-xl border bg-surface p-1" aria-label="Strategies sections">
        {views.map((item) => <Link key={item.id} href={`/strategies?view=${item.id}`} aria-current={view === item.id ? "page" : undefined} className={cn("min-h-10 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground", view === item.id && "bg-background text-foreground shadow-sm")}>{item.label}</Link>)}
      </nav>
      {view === "library" && <Strategies />}
      {view === "builder" && <><div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm lg:hidden">Strategy editing is desktop-first. A read-only overview remains available on mobile; use a desktop viewport for safe rule editing.</div><div className="hidden lg:block"><StrategyBuilder /></div></>}
      {view === "assignments" && <StrategyAssignmentMatrix />}
      {view === "evidence" && <Memory />}
    </div>
  );
}

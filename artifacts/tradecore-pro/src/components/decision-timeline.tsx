import { CheckCircle2, XCircle, MinusCircle, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * One step of the five-stage pipeline: Market Data → Indicators → Signal →
 * Risk Checks → Order. Same shape as the server's PipelineStage
 * (decisionTrace.ts) — this component renders that trace verbatim, never a
 * narrative reconstruction of it.
 */
export interface DecisionTimelineStage {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  data?: Record<string, unknown> | null;
}

const STATUS_META: Record<DecisionTimelineStage["status"], { icon: typeof CheckCircle2; className: string }> = {
  pass: { icon: CheckCircle2, className: "text-success" },
  fail: { icon: XCircle, className: "text-destructive" },
  skip: { icon: MinusCircle, className: "text-muted-foreground" },
};

/**
 * The full pipeline trace, one row per stage, in order. Each row's `data`
 * (indicator values, risk-check numbers) expands on click — collapsed by
 * default so the timeline reads as a funnel at a glance.
 */
export function DecisionTimeline({ stages }: { stages: DecisionTimelineStage[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (stages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No decision trace was captured for this plan.
      </p>
    );
  }

  return (
    <ol className="space-y-1">
      {stages.map((stage, i) => {
        const meta = STATUS_META[stage.status] ?? STATUS_META.skip;
        const Icon = meta.icon;
        const hasData = stage.data && Object.keys(stage.data).length > 0;
        const isOpen = openIndex === i;
        return (
          <li key={`${stage.name}-${i}`} className="rounded-md border border-border/60">
            <button
              type="button"
              onClick={() => hasData && setOpenIndex(isOpen ? null : i)}
              className={cn(
                "w-full flex items-start gap-2.5 p-2.5 text-left",
                hasData && "hover:bg-muted/40 transition-colors",
              )}
              aria-expanded={hasData ? isOpen : undefined}
            >
              <Icon className={cn("h-4 w-4 shrink-0 mt-0.5", meta.className)} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-mono font-medium">{stage.name}</span>
                  {hasData && (isOpen ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />)}
                </div>
                <p className="text-[13px] text-muted-foreground mt-0.5 leading-relaxed">{stage.detail}</p>
              </div>
            </button>
            {hasData && isOpen && (
              <dl className="px-2.5 pb-2.5 pl-9 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
                {Object.entries(stage.data!).map(([key, value]) => (
                  <div key={key} className="text-[13px]">
                    <dt className="text-muted-foreground font-mono">{key}</dt>
                    <dd className="font-mono">
                      {typeof value === "object" ? JSON.stringify(value) : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        );
      })}
    </ol>
  );
}

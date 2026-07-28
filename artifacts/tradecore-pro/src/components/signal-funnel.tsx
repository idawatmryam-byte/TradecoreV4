import { useGetDecisionFunnel, getGetDecisionFunnelQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { Filter, ArrowRight } from "lucide-react";

/**
 * Where this section's signals went.
 *
 * This panel exists because of a specific failure: the engine produced ~3,300
 * signals over two days, vetoed every single one at one stage, executed
 * nothing, and no screen in the product said so. It read as "the engine is
 * lazy". The decision journal had recorded all of it the whole time — nothing
 * aggregated it, so finding out took a database export.
 *
 * The number that matters is the conversion, so that is what leads. A run
 * that converts 0% is stated as 0%, in the destructive colour, with the stage
 * and the verbatim reason that caused it — because "coin-fit" alone doesn't
 * tell you which setting to change, and the reason string does.
 */
export function SignalFunnel() {
  const { data, isLoading } = useGetDecisionFunnel(
    { hours: 24 },
    { query: { queryKey: getGetDecisionFunnelQueryKey({ hours: 24 }), refetchInterval: 60_000 } },
  );

  // No decisions at all is a different statement from "nothing converted", and
  // conflating them would be the fabrication this codebase keeps guarding
  // against. An engine that has not run yet has no funnel, not a 0% one.
  if (isLoading || !data || data.signals === 0) return null;

  const { signals, executed, rejected, approvedNotTaken, stages } = data;
  const conversion = (executed / signals) * 100;
  const stalled = executed === 0;
  const top = stages[0];

  return (
    <Card className={cn(stalled && "border-destructive/40")}>
      <CardContent className="p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            <Filter className="h-3.5 w-3.5" aria-hidden /> Signals, last 24h
          </p>
          <Link
            href="/decisions"
            className="ml-auto text-[13px] font-medium text-primary hover:underline"
          >
            Decision history
          </Link>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <span className="numeric text-[28px] font-semibold leading-none">{signals.toLocaleString()}</span>
          <span className="text-[13px] text-muted-foreground">considered</span>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className={cn(
            "numeric text-[28px] font-semibold leading-none",
            stalled ? "text-destructive" : "text-success",
          )}>
            {executed.toLocaleString()}
          </span>
          <span className="text-[13px] text-muted-foreground">
            traded · {conversion < 1 && conversion > 0 ? conversion.toFixed(2) : conversion.toFixed(0)}%
          </span>
        </div>

        {stalled && (
          <p className="mt-3 text-[13px] font-medium text-destructive">
            Nothing has converted. The engine is finding setups and rejecting all of them.
          </p>
        )}

        {/* The stage name is the diagnosis; the reason is the prescription. */}
        {top && (
          <div className="mt-4 rounded-lg border bg-muted/40 p-3">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[13px] font-semibold">{top.stage}</span>
              <span className="numeric text-[13px] text-muted-foreground">
                {top.count.toLocaleString()} rejections
              </span>
            </div>
            {top.topReason && (
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{top.topReason}</p>
            )}
          </div>
        )}

        {(stages.length > 1 || approvedNotTaken > 0) && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            {stages.slice(1, 4).map((s) => (
              <span key={s.stage} className="numeric">
                {s.stage} <span className="text-foreground">{s.count.toLocaleString()}</span>
              </span>
            ))}
            {approvedNotTaken > 0 && (
              <span className="numeric">
                approved, not taken <span className="text-foreground">{approvedNotTaken.toLocaleString()}</span>
              </span>
            )}
          </div>
        )}

        {rejected > 0 && executed > 0 && (
          <p className="mt-3 text-[13px] text-muted-foreground">
            {rejected.toLocaleString()} rejected — normal, as long as the conversion above is not zero.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

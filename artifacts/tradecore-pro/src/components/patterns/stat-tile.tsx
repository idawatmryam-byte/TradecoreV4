import { Card, CardContent, Skeleton } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/**
 * A labelled number.
 *
 * There were three of these — `Stat` on the dashboard, `Metric` on
 * backtesting, `StatCard` on strategies — differing in label size (10px /
 * 11px / 12px), letter-spacing, padding, whether the value was monospace and
 * whether it used tabular figures. Four tiles side by side from two different
 * implementations is the most visible way a product looks unfinished.
 *
 * `tabular-nums` is not optional here: without it, digits have different
 * widths and a value that ticks every few seconds visibly jitters.
 *
 * Pass `value={null}` for "not known" rather than substituting a zero — that
 * distinction is the whole point of the statistical-honesty work, and a tile
 * is exactly where it gets quietly lost.
 */
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = "neutral",
  loading,
  footer,
  valueClass,
  className,
}: {
  label: string;
  /** Pre-formatted. `null` renders the not-known placeholder. */
  value: React.ReactNode;
  hint?: string;
  icon?: LucideIcon;
  tone?: "neutral" | "positive" | "negative" | "primary" | "muted";
  loading?: boolean;
  /** Extra content under the value — a progress bar, a secondary note. */
  footer?: React.ReactNode;
  /** Escape hatch for a computed colour that `tone` can't express. */
  valueClass?: string;
  className?: string;
}) {
  const toneClass = {
    neutral: "",
    positive: "text-success",
    negative: "text-destructive",
    primary: "text-primary",
    muted: "text-muted-foreground",
  }[tone];

  return (
    <Card className={className}>
      <CardContent className="p-4 sm:p-5">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          {label}
        </p>
        {loading ? (
          <Skeleton className="mt-2 h-8 w-24" />
        ) : (
          <p className={cn("mt-1.5 truncate text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl", toneClass, valueClass)}>
            {value ?? "—"}
          </p>
        )}
        {hint && !loading && <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>}
        {footer && !loading && footer}
      </CardContent>
    </Card>
  );
}

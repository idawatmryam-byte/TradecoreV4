import { Link } from "wouter";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/**
 * The one empty state.
 *
 * Before this there were three idioms across the app, differing in icon
 * opacity (20% / 40% / 50%), padding (py-8 / py-10 / py-12) and casing, so
 * "nothing here yet" looked like a different kind of event depending on which
 * page you were on.
 *
 * The rule this encodes: an empty screen must say what is missing AND what
 * produces it. "No trades found" leaves a user stuck; "No trades yet — the
 * engine opens one when a strategy finds a setup" tells them whether to wait
 * or to act. Where there IS an action, it gets a button.
 *
 * This is also the honest alternative to a zeroed-out statistic. A page with
 * no data renders this, not `0.00%`.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: LucideIcon;
  title: string;
  /** What produces the missing thing, or what to do next. */
  description?: string;
  action?: { label: string; href?: string; onClick?: () => void };
  className?: string;
  /** Tighter padding, for use inside a card that is already small. */
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "px-4 py-8" : "px-6 py-12",
        className,
      )}
    >
      {Icon && <Icon className="mb-3 h-8 w-8 text-muted-foreground/40" aria-hidden />}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action && (
        <div className="mt-4">
          {action.href ? (
            <Link href={action.href}>
              <Button size="sm" variant="outline" onClick={action.onClick}>
                {action.label}
              </Button>
            </Link>
          ) : (
            <Button size="sm" variant="outline" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

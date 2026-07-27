import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/**
 * The page title block.
 *
 * Eight pages hand-rolled this same five-line structure at three different
 * sizes (`text-2xl` vs `text-xl`, with and without `tracking-tight`, `h-6`
 * vs `h-5` icons), and two pages had no header at all. One definition, so a
 * page cannot look like a different product by accident.
 *
 * `actions` sits on the right on desktop and wraps beneath the title on a
 * phone, rather than fighting the heading for a single row.
 */
export function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          {Icon && <Icon className="h-5 w-5 shrink-0 text-primary" aria-hidden />}
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Tabs across sibling routes.
 *
 * The navigation consolidation merges related pages into one destination —
 * Portfolio holds the trade log and the journal, Performance holds analytics
 * and decision history, Settings holds trading config and profile. Merging by
 * *linking* rather than by combining components means both routes stay valid
 * and bookmarkable, which is what keeps this a presentation change rather than
 * a rename of something addressable.
 *
 * Horizontally scrollable on a phone so a third tab never wraps into a second
 * row that looks like a broken layout.
 */
export function PageTabs({ tabs, className }: { tabs: { href: string; label: string }[]; className?: string }) {
  const [location] = useLocation();
  return (
    <div className={cn("-mx-1 overflow-x-auto", className)}>
      <div className="inline-flex min-w-full gap-1 border-b px-1">
        {tabs.map((tab) => {
          const active = location === tab.href || location.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

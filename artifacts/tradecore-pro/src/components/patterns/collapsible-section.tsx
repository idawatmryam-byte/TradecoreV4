import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A titled panel the user can fold away, remembering their choice.
 *
 * Promoted out of `dashboard.tsx`, where it was defined locally while three
 * other pages grew their own unrelated collapsibles — a clickable CardHeader
 * on Performance, expand-on-click card bodies on Journal and Decision History
 * — none of which persisted, and each with its own chevron treatment.
 *
 * The persistence matters more than it looks. Progressive disclosure only
 * works if it is a preference rather than a fight: a user who opens the
 * market monitor should find it open tomorrow, and a user who closes it
 * should never have to close it twice.
 */
export function CollapsibleSection({
  id,
  title,
  icon: Icon,
  right,
  defaultOpen = true,
  children,
}: {
  /** Stable key for the remembered open/closed state. */
  id: string;
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Header content shown even while collapsed — a count, a status pill. */
  right?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const storageKey = `panel:${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored == null ? defaultOpen : stored === "1";
    } catch {
      return defaultOpen;
    }
  });

  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* private mode */
      }
      return next;
    });

  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={cn(
          "flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border bg-card px-4 text-left transition-colors hover:bg-muted/40",
          open && "rounded-b-none border-b-0",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="truncate text-sm font-medium">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {right}
          <ChevronDown
            className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </span>
      </button>
      {open && (
        <div className="overflow-hidden rounded-b-lg border border-t-0">{children}</div>
      )}
    </section>
  );
}

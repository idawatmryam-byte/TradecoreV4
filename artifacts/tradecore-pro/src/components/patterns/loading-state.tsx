import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Loading placeholders.
 *
 * There were four idioms: pulsing empty cards, a centred spinner, an inline
 * spinner with the word "Loading…", and mono uppercase text inside a table
 * cell. A spinner says "something is happening"; a skeleton says "something is
 * happening AND here is the shape of what is coming", which stops the layout
 * jumping when the data lands.
 *
 * These deliberately do not animate a spinner — a skeleton that mirrors the
 * final layout is calmer and reads as faster even when it isn't.
 */

/** Rows of a table or list. */
export function LoadingRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2 p-4", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-24 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** A grid of cards, for pages that render card collections. */
export function LoadingCards({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-44 w-full rounded-xl" />
      ))}
    </div>
  );
}

/** A block of form fields inside a card. */
export function LoadingFields({ fields = 3, className }: { fields?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)}>
      <Skeleton className="h-4 w-40" />
      {Array.from({ length: fields }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

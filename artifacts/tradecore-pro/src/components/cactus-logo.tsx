import { cn } from "@/lib/utils";

/**
 * The saguaro.
 *
 * Two arms at deliberately different heights — a symmetrical cactus reads as a
 * candelabra, and the asymmetry is what makes the silhouette recognisable at
 * the size it actually gets used: a 20px browser tab and a 28px sidebar.
 *
 * Drawn with `currentColor` and no internal palette so one mark serves every
 * placement: cactus green on sand, cloud knocked out of green, ink on white.
 * The trunk is a rounded rect rather than a stroked line so it keeps its
 * weight when the arms' stroke scales.
 */
export function CactusMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-5 w-5", className)}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="10.25" y="2.5" width="3.5" height="19" rx="1.75" fill="currentColor" />
      <path
        d="M10.25 13.5 H7.6 Q5.6 13.5 5.6 11.5 V8.8"
        stroke="currentColor"
        strokeWidth="3.1"
        strokeLinecap="round"
      />
      <path
        d="M13.75 11 H16.4 Q18.4 11 18.4 9 V6.6"
        stroke="currentColor"
        strokeWidth="3.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Mark plus wordmark. `tagline` is off by default: it belongs on the login
 * screen and the onboarding wizard, where the product is introducing itself,
 * and nowhere else — repeating "AI trading platform" on every screen of the
 * platform tells a returning user nothing.
 */
export function CactusLogo({
  size = "sm",
  tagline = false,
  className,
}: {
  size?: "sm" | "lg";
  tagline?: boolean;
  className?: string;
}) {
  const large = size === "lg";
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10",
          large ? "h-9 w-9" : "h-8 w-8",
        )}
      >
        <CactusMark className={cn("text-primary", large ? "h-5 w-5" : "h-4 w-4")} />
      </div>
      <div className="flex min-w-0 flex-col leading-none">
        <span className={cn("font-semibold tracking-tight", large ? "text-lg" : "text-[15px]")}>
          Cactus AI
        </span>
        {tagline && (
          <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
            AI trading platform
          </span>
        )}
      </div>
    </div>
  );
}

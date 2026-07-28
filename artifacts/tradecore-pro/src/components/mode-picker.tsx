import { cn } from "@/lib/utils";

/**
 * Who authorises a trade: Research / Co-Pilot / AutoPilot.
 *
 * Extracted from `settings.tsx` so the onboarding wizard asks the question the
 * same way Settings does — same three options, same wording, same ordering.
 * A new user meeting one phrasing at signup and a different one a day later in
 * Settings would reasonably think they were two different settings.
 *
 * Three named choices rather than a toggle: they are not two ends of one axis,
 * and "off/on" would leave Research unreachable. The analysis pipeline is
 * identical in all three — only the executor at the end differs, which is why
 * this is a setting and not a different product.
 */

export type TradingMode = "research" | "copilot" | "autopilot";

export const MODE_OPTIONS = [
  { value: "copilot",   label: "Co-Pilot",  blurb: "It recommends, you approve each trade." },
  { value: "autopilot", label: "AutoPilot", blurb: "It executes automatically within your risk limits." },
  { value: "research",  label: "Research",  blurb: "Analysis only — it never trades." },
] as const satisfies ReadonlyArray<{ value: TradingMode; label: string; blurb: string }>;

/** Display names for a mode, for badges and confirmation copy. */
export const MODE_LABELS: Record<string, string> = {
  copilot: "Co-Pilot", autopilot: "AutoPilot", research: "Research",
};

export function ModePicker({
  value,
  onChange,
  /** Marks Co-Pilot as the suggested starting point. Onboarding only. */
  showRecommended = false,
}: {
  value: TradingMode;
  onChange: (mode: TradingMode) => void;
  showRecommended?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {MODE_OPTIONS.map((m) => {
        const active = value === m.value;
        const recommended = showRecommended && m.value === "copilot";
        return (
          <button
            key={m.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(m.value)}
            className={cn(
              "rounded-md border p-3 text-left transition-colors",
              active
                ? "border-primary bg-primary/10"
                : "border-border hover:bg-muted/50",
            )}
          >
            <span className={cn("flex items-center gap-2 text-sm font-semibold", active && "text-primary")}>
              {m.label}
              {recommended && (
                <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
                  Recommended
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
              {m.blurb}
            </span>
          </button>
        );
      })}
    </div>
  );
}

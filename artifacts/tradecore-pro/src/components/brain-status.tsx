import { useGetBotStatus, useGetConfig } from "@workspace/api-client-react";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Cpu, ShieldCheck } from "lucide-react";

export const ACTIVE_BRAIN = {
  version: "Brain V0",
  role: "Control",
  validation: "Baseline contract locked",
} as const;

function operatingMode(config: any, bot: any): string {
  if (config?.mode === "research") return "Research";
  if (config?.mode === "copilot") return "Co-Pilot";
  if (config?.executionTarget === "demo" || bot?.mode === "testnet") return "Demo";
  if (bot?.mode === "backtest") return "Research";
  return "Live";
}

/**
 * Read-only Phase 0 identity strip. It deliberately derives operating mode
 * from the current configuration and does not mutate or influence the engine.
 */
export function BrainStatusStrip({ compact = false }: { compact?: boolean }) {
  const { data: config, isLoading: configLoading, isError: configError } = useGetConfig();
  const { data: bot, isLoading: botLoading, isError: botError } = useGetBotStatus();
  const unknown = configLoading || botLoading || configError || botError;
  const mode = unknown ? "Unknown" : operatingMode(config, bot);
  const live = mode === "Live";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border/70 bg-card/60 px-3 py-2.5",
        !compact && "sm:px-4",
      )}
      aria-label="Active intelligence version"
    >
      <span className="inline-flex items-center gap-2 text-sm font-semibold">
        <Cpu className="h-4 w-4 text-primary" aria-hidden="true" />
        {ACTIVE_BRAIN.version}
      </span>
      <Badge variant="outline" className="font-mono text-[10px]">{ACTIVE_BRAIN.role}</Badge>
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        {ACTIVE_BRAIN.validation}
      </span>
      <span className={cn(
        "ml-0 font-mono text-[11px] font-semibold sm:ml-auto",
        unknown ? "text-muted-foreground" : live ? "text-destructive" : "text-primary",
      )}>
        {unknown ? "Mode unavailable" : mode + " mode"}
      </span>
    </div>
  );
}

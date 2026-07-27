import { Link } from "wouter";
import { useGetCopilotInbox, getGetCopilotInboxQueryKey, useGetConfig, getGetConfigQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, Button, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Inbox, ArrowUpRight, ArrowDownRight, ChevronRight } from "lucide-react";

/**
 * "What is the AI recommending?" — the dashboard's third question.
 *
 * Deliberately a summary, not the inbox. The dashboard is being shortened, and
 * pasting a full recommendation list back onto it would undo that; what a user
 * needs above the fold is whether anything is waiting and what the top item
 * is, with one tap to the rest.
 *
 * The one-line rationale is not decoration. Transparency outranks
 * simplification here: a recommendation summarised without any "why" is the
 * product asking to be trusted rather than showing its work, and the whole
 * card links straight to the full reasoning rather than to a bare trade
 * ticket.
 *
 * Only rendered in Co-Pilot mode — in AutoPilot the engine executes and there
 * is nothing waiting on the user, so an empty inbox card would be noise.
 */
export function CopilotSummary() {
  const { data: config } = useGetConfig({ query: { queryKey: getGetConfigQueryKey() } });
  const isCopilot = config?.mode === "copilot";

  const { data } = useGetCopilotInbox(undefined, {
    query: {
      queryKey: getGetCopilotInboxQueryKey(),
      enabled: isCopilot,
      refetchInterval: 15000,
    },
  });

  if (!isCopilot) return null;

  const pending = data?.recommendations ?? [];
  const top = pending[0];

  if (pending.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Inbox className="h-5 w-5 shrink-0 text-muted-foreground/50" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Nothing waiting on you</p>
            <p className="truncate text-xs text-muted-foreground">
              In Co-Pilot the engine recommends and never opens a position on its own.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const isLong = top!.side === "long";

  return (
    <Link href={`/copilot/${top!.id}`}>
      <Card className="transition-colors hover:border-primary/50 hover:bg-muted/30">
        <CardContent className="flex items-center gap-3 p-4">
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
              isLong ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
            )}
          >
            {isLong ? <ArrowUpRight className="h-5 w-5" /> : <ArrowDownRight className="h-5 w-5" />}
          </span>

          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              <span className="truncate">
                {top!.symbol} {isLong ? "long" : "short"}
              </span>
              <Badge variant="default" className="shrink-0">
                {pending.length} waiting
              </Badge>
            </p>
            {/* The "why", from the plan the engine actually made. */}
            <p className="truncate text-xs text-muted-foreground">
              {top!.strategyName} · {top!.entryReason || "Open for the full reasoning"}
            </p>
          </div>

          <Button variant="ghost" size="sm" className="shrink-0 gap-1" tabIndex={-1}>
            Review <ChevronRight className="h-4 w-4" />
          </Button>
        </CardContent>
      </Card>
    </Link>
  );
}

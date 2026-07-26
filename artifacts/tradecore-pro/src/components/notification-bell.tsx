import { useQueryClient } from "@tanstack/react-query";
import {
  useGetNotifications, getGetNotificationsQueryKey,
  useMarkNotificationRead, useMarkAllNotificationsRead,
} from "@workspace/api-client-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Bell, ShieldAlert, Info, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const SEVERITY_ICON: Record<string, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  critical: ShieldAlert,
};
const SEVERITY_CLASS: Record<string, string> = {
  info: "text-primary",
  warning: "text-warning",
  critical: "text-destructive",
};

/**
 * In-app mirror of the risk-alert webhook (circuit breaker, risk pause,
 * untracked-position detection) — visible even if the user never configured
 * a webhook URL. Polls like every other page in the app (no WebSocket).
 */
export function NotificationBell() {
  const queryClient = useQueryClient();
  const { data } = useGetNotifications(
    { limit: 20 },
    { query: { refetchInterval: 20_000, queryKey: getGetNotificationsQueryKey({ limit: 20 }) } },
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetNotificationsQueryKey({ limit: 20 }) });
  const { mutate: markRead } = useMarkNotificationRead({ mutation: { onSuccess: invalidate } });
  const { mutate: markAllRead } = useMarkAllNotificationsRead({ mutation: { onSuccess: invalidate } });

  const unreadCount = data?.unreadCount ?? 0;
  const items = data?.notifications ?? [];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
          className="relative p-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      {/* bg-card/text-foreground, not the unused bg-popover/text-popover-foreground
          defaults — this app never defined --popover in index.css, so those
          resolve to a transparent background (sidebar text bled through). */}
      <PopoverContent align="end" className="w-80 p-0 max-h-96 overflow-y-auto bg-card text-foreground border-border">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Notifications</span>
          {unreadCount > 0 && (
            <button
              type="button"
              className="text-[11px] text-primary hover:underline"
              onClick={() => markAllRead()}
            >
              Mark all read
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">No notifications yet.</p>
        ) : (
          <ul>
            {items.map((n) => {
              const Icon = SEVERITY_ICON[n.severity] ?? Info;
              const unread = n.readAt == null;
              return (
                <li
                  key={n.id}
                  className={cn("flex items-start gap-2 px-3 py-2.5 border-b last:border-0 text-xs", unread && "bg-primary/5")}
                >
                  <Icon className={cn("h-3.5 w-3.5 shrink-0 mt-0.5", SEVERITY_CLASS[n.severity] ?? "text-muted-foreground")} />
                  <div className="min-w-0 flex-1">
                    <p className={cn("leading-snug", unread ? "text-foreground" : "text-muted-foreground")}>{n.message}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {new Date(n.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                  {unread && (
                    <button
                      type="button"
                      className="text-[10px] text-primary hover:underline shrink-0"
                      onClick={() => markRead({ id: n.id })}
                    >
                      Read
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

import * as React from "react"
import { X } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { cn } from "@/lib/utils"

export function Toaster() {
  const { toasts, dismiss } = useToast()

  return (
    <div className="fixed top-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col md:max-w-[420px]">
      {toasts.filter((t) => t.open !== false).map(function ({ id, title, description, action, variant, open, onOpenChange, ...props }) {
        return (
          <div
            key={id}
            {...props}
            className={cn("group pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-md border p-6 pr-10 shadow-lg transition-all mb-2 bg-card", variant === "destructive" ? "border-destructive text-destructive" : "border-border")}
          >
            <div className="grid gap-1">
              {title && <div className="text-sm font-semibold">{title}</div>}
              {description && (
                <div className="text-sm opacity-90">{description}</div>
              )}
            </div>
            {action}
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(id)}
              className={cn(
                "absolute right-2 top-2 rounded-md p-1.5 transition-colors",
                variant === "destructive"
                  ? "text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              )}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export type ToastProps = React.HTMLAttributes<HTMLDivElement> & { variant?: "default" | "destructive" }
export type ToastActionElement = React.ReactElement

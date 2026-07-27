import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

/**
 * The one confirmation in the Demo → Live upgrade.
 *
 * Research and Co-Pilot carry into Live with no extra step: in both, a human
 * still stands between a signal and an order. AutoPilot does not — the moment
 * credentials verify, the engine can place real orders with no approval, and
 * the upgrade flow otherwise only ever asks for API keys. Carrying that
 * combination across silently is the one place where saying nothing would be a
 * design failure rather than useful brevity.
 *
 * Escape and the overlay resolve to "Switch to Co-Pilot" rather than
 * dismissing the dialog: an interrupted upgrade should land on the safe side,
 * never leave AutoPilot armed because someone hit a key to get rid of a modal.
 */
export function AutoPilotConfirmDialog({
  open,
  marketLabel,
  onSwitchToCopilot,
  onContinueWithAutoPilot,
}: {
  open: boolean;
  /** e.g. "Crypto" — names which market is being upgraded. */
  marketLabel: string;
  onSwitchToCopilot: () => void;
  onContinueWithAutoPilot: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onSwitchToCopilot(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            You're about to trade {marketLabel} live on AutoPilot
          </AlertDialogTitle>
          <AlertDialogDescription>
            AutoPilot executes trades automatically with real funds. Once this
            section is live, the engine can open and close positions on your
            account without asking first — your risk limits are the only thing
            standing between it and your balance.
            <span className="mt-3 block">
              Co-Pilot runs the identical analysis and still recommends every
              trade, but waits for you to approve each one. You can move to
              AutoPilot at any time from Settings.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* The recommended option is also the Escape/overlay action, so an
              accidental dismissal can only ever be the safer outcome. */}
          <AlertDialogCancel
            onClick={onSwitchToCopilot}
            className="mt-0 border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:text-primary-foreground"
          >
            Switch to Co-Pilot (Recommended)
          </AlertDialogCancel>
          <Button variant="outline" onClick={onContinueWithAutoPilot}>
            Continue with AutoPilot
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

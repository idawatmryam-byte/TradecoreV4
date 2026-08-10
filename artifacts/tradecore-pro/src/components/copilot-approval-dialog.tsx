import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";

export function CopilotApprovalDialog({
  open,
  onOpenChange,
  symbol,
  side,
  target,
  quantity,
  entryPrice,
  stopPrice,
  targetPrice,
  leverage,
  maximumLoss,
  approvable,
  readinessReason,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  symbol: string;
  side: "long" | "short";
  target: "demo" | "live";
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  leverage: number;
  maximumLoss: number;
  approvable: boolean;
  readinessReason: string;
  pending: boolean;
  onConfirm: (input: { confirmation: string; password?: string }) => void;
}) {
  const phrase = `APPROVE ${symbol} ${side.toUpperCase()} FOR ${target.toUpperCase()}`;
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!open) {
      setConfirmation("");
      setPassword("");
    }
  }, [open]);

  const enabled =
    approvable &&
    confirmation === phrase &&
    (target === "demo" || password.length > 0) &&
    !pending;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {target === "live" ? (
              <AlertTriangle className="h-5 w-5 text-destructive" />
            ) : (
              <ShieldCheck className="h-5 w-5 text-primary" />
            )}
            Authorize one {target.toUpperCase()} execution attempt
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left">
              <p>
                Approval does not bypass safety. TradeCore will freshly
                revalidate the market, thesis, portfolio, exposure, risk,
                reconciliation, mode, target, and executor.
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border p-3 font-mono text-xs">
                <div>
                  <dt className="text-muted-foreground">Proposal</dt>
                  <dd className="font-semibold text-foreground">
                    {symbol} {side}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Target</dt>
                  <dd
                    className={
                      target === "live"
                        ? "font-semibold text-destructive"
                        : "font-semibold text-foreground"
                    }
                  >
                    {target.toUpperCase()}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Quantity</dt>
                  <dd className="text-foreground">{quantity}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Leverage</dt>
                  <dd className="text-foreground">{leverage}x</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Entry / Stop</dt>
                  <dd className="text-foreground">
                    {entryPrice} / {stopPrice}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Target / Max loss</dt>
                  <dd className="text-foreground">
                    {targetPrice} / ${maximumLoss.toFixed(2)}
                  </dd>
                </div>
              </dl>
              <p
                className={
                  approvable
                    ? "text-muted-foreground"
                    : "font-semibold text-destructive"
                }
              >
                {readinessReason}
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="copilot-confirmation">
                  Type the exact authorization phrase
                </Label>
                <p className="select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
                  {phrase}
                </p>
                <Input
                  id="copilot-confirmation"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  className="font-mono"
                />
              </div>
              {target === "live" && (
                <div className="space-y-1.5">
                  <Label htmlFor="copilot-step-up">
                    Current password (Live step-up)
                  </Label>
                  <Input
                    id="copilot-step-up"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant={target === "live" ? "destructive" : "default"}
            disabled={!enabled}
            onClick={() =>
              onConfirm({
                confirmation,
                ...(target === "live" && { password }),
              })
            }
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Authorize one attempt
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

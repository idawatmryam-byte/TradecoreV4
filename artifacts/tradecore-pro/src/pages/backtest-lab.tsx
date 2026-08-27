import { FlaskConical, ShieldCheck } from "lucide-react";
import { Backtest } from "@/pages/backtest";

export function BacktestLab() {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-practice/40 bg-practice/10 p-4" role="note">
        <div className="flex items-center gap-2 text-sm font-semibold text-practice"><FlaskConical className="h-4 w-4" /> Historical simulation / Research only</div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">No Demo or Live order can be placed from Backtest Lab. Provider incompleteness, synthetic-data refusal, holdout status, and research evidence remain explicit.</p>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5" /> Backtest results do not grant strategy or execution authority.</div>
      </div>
      <Backtest />
    </div>
  );
}

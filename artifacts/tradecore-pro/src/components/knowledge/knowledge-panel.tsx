import {
  Card, CardHeader, CardTitle, CardContent, Badge,
  Table, TableHeader, TableRow, TableHead, TableBody, TableCell,
} from "@/components/ui";
import { useGetKnowledge, getGetKnowledgeQueryKey, type KnowledgeCell } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Microscope, Gauge, Info } from "lucide-react";

/**
 * Market Knowledge — where this account's own record supports a claim, and,
 * just as prominently, where it does not.
 *
 * The design problem this panel solves is that a win rate from 12 trades
 * renders identically to one from 1,200, and readers anchor on whichever
 * number is on the screen. So a gated cell shows its sample count and a
 * "needs N" marker where the percentage would go — there is deliberately no
 * greyed-out figure to squint at, because a greyed-out number is still a
 * number. Above the gate, the win rate arrives with its 95% interval attached,
 * and the "edge" badge appears only for cells that survive the
 * multiple-comparison correction the server applies across every cell tested.
 */

const DIMENSION_LABELS: Record<string, string> = {
  strategy_regime: "Strategy × Regime",
  symbol_strategy: "Symbol × Strategy",
  session: "Session",
  volatility: "Volatility",
};

function pct(n: number | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(0)}%`;
}

function CellRow({ cell }: { cell: KnowledgeCell }) {
  const edge = cell.significance?.significant === true;
  const beatsBaseline = cell.winRate != null && cell.significance != null;

  return (
    <TableRow>
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          <span className="truncate">{cell.label}</span>
          {edge && (
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 text-[13px]",
                cell.winRate != null && cell.winRate >= 0.5
                  ? "border-success/40 text-success"
                  : "border-destructive/40 text-destructive",
              )}
            >
              {cell.winRate != null && cell.winRate >= 0.5 ? "edge" : "drag"}
            </Badge>
          )}
        </div>
        <span className="text-[13px] text-muted-foreground">
          {DIMENSION_LABELS[cell.dimension] ?? cell.dimension}
        </span>
      </TableCell>

      <TableCell className="font-mono text-right">{cell.samples}</TableCell>

      <TableCell className="font-mono text-right">
        {cell.gated ? (
          <span className="text-[13px] text-muted-foreground">
            needs {cell.minSamples - cell.samples} more
          </span>
        ) : (
          <>
            <span className="font-bold">{pct(cell.winRate)}</span>
            {cell.winRateLow != null && cell.winRateHigh != null && (
              <span className="ml-1 text-[10px] text-muted-foreground">
                {pct(cell.winRateLow)}–{pct(cell.winRateHigh)}
              </span>
            )}
          </>
        )}
      </TableCell>

      <TableCell className="font-mono text-right">
        {cell.gated ? <span className="text-muted-foreground">—</span> : cell.avgR?.toFixed(2) ?? "—"}
      </TableCell>

      <TableCell className="font-mono text-right text-[13px] text-muted-foreground">
        {beatsBaseline ? `q=${cell.significance!.qValue.toFixed(3)}` : "—"}
      </TableCell>
    </TableRow>
  );
}

export function KnowledgePanel() {
  const { data, isLoading } = useGetKnowledge({ query: { queryKey: getGetKnowledgeQueryKey() } });

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-[15px] flex items-center gap-2">
            <Microscope className="h-4 w-4" /> Market Knowledge
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Reading the trade record…</p>
        </CardContent>
      </Card>
    );
  }

  const cal = data.calibration;
  const ungated = data.cells.filter((c) => !c.gated).length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-[15px] flex items-center gap-2">
            <Microscope className="h-4 w-4 text-primary" /> Market Knowledge
            <Badge variant="outline" className="ml-auto text-[13px]">
              {data.executionTarget}
            </Badge>
          </CardTitle>
          <p className="text-[13px] text-muted-foreground">
            {data.totalTrades} closed trades · baseline win rate{" "}
            {data.baselineWinRate != null
              ? pct(data.baselineWinRate)
              : `not yet measurable (needs ${data.minSamples})`}
            {data.cellsTested > 0 && ` · ${ungated} of ${data.cells.length} cells past the gate, ${data.cellsTested} tested at FDR ${data.fdr}`}
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Cell</TableHead>
                <TableHead className="text-right">Trades</TableHead>
                <TableHead className="text-right">Win Rate (95% CI)</TableHead>
                <TableHead className="text-right">Avg R</TableHead>
                <TableHead className="text-right">q</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.cells.map((c) => <CellRow key={`${c.dimension}:${c.key}`} cell={c} />)}
              {data.cells.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground text-sm">
                    No closed trades yet. Knowledge builds itself as the record grows.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px] flex items-center gap-2">
            <Gauge className="h-4 w-4 text-primary" /> Confidence Calibration
          </CardTitle>
          <p className="text-[13px] text-muted-foreground">
            Does a confidence of 70 actually win 70% of the time on this account?
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {cal.gated ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Not enough settled trades to answer honestly.
              </p>
              <p className="text-[13px] font-mono text-muted-foreground">
                {cal.validationSamples}/{cal.minSamples} in the validation window
                {cal.samplesNeeded > 0 && ` · ${cal.samplesNeeded} more needed`}
              </p>
              <p className="text-[13px] text-muted-foreground flex gap-1.5">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                The curve is fitted on earlier trades and scored on later ones, so
                the gate counts only the trades used for scoring.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 font-mono text-sm">
                <div>
                  <p className="text-[13px] text-muted-foreground">Brier (raw)</p>
                  <p className="font-bold">{cal.raw.brier?.toFixed(3) ?? "—"}</p>
                </div>
                <div>
                  <p className="text-[13px] text-muted-foreground">Brier (calibrated)</p>
                  <p className="font-bold">{cal.calibrated.brier?.toFixed(3) ?? "—"}</p>
                </div>
                <div>
                  <p className="text-[13px] text-muted-foreground">ECE</p>
                  <p className="font-bold">{cal.calibrated.ece?.toFixed(3) ?? "—"}</p>
                </div>
                <div>
                  <p className="text-[13px] text-muted-foreground">Base rate only</p>
                  <p className="font-bold">{cal.climatologyBrier?.toFixed(3) ?? "—"}</p>
                </div>
              </div>

              <div
                className={cn(
                  "text-[13px] rounded border px-2 py-1.5",
                  cal.beatsClimatology
                    ? "border-success/40 text-success"
                    : "border-warning/40 text-warning",
                )}
              >
                {cal.beatsClimatology
                  ? "Confidence carries real information — the calibrated forecast beats simply predicting the base rate."
                  : "Confidence does not yet beat predicting the base rate. Treat the score as an ordering, not a probability."}
              </div>

              <div>
                <p className="text-[13px] text-muted-foreground mb-1">
                  Reliability — promised vs observed
                </p>
                <div className="space-y-0.5">
                  {cal.bins.filter((b) => b.count > 0).map((b) => (
                    <div key={b.low} className="flex items-center gap-2 text-[13px] font-mono">
                      <span className="w-16 shrink-0 text-muted-foreground">
                        {(b.low * 100).toFixed(0)}–{(b.high * 100).toFixed(0)}%
                      </span>
                      <span className="w-10 shrink-0 text-right">{pct(b.observedRate)}</span>
                      <span className="flex-1 h-1.5 bg-muted rounded overflow-hidden">
                        <span
                          className="block h-full bg-primary"
                          style={{ width: `${(b.observedRate ?? 0) * 100}%` }}
                        />
                      </span>
                      <span className="w-8 shrink-0 text-right text-muted-foreground">n={b.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

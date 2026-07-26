import { useGetPortfolioCorrelation } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Loader2, Grid3x3 } from "lucide-react";

/**
 * Correlation heat map — which of your pairs are really the same bet.
 *
 * The card exists because the other risk numbers on this dashboard cannot
 * show this: five "independent" long positions across correlated majors look
 * like five positions to every count-, notional- and direction-based cap, and
 * like one position to the market.
 *
 * Two rules this component does not bend:
 *   • A pair without enough shared history renders "—", never a number. A 0
 *     would read as "measured, and unrelated", which is an unearned claim.
 *   • Colour is never the only signal. Every cell shows its numeric value,
 *     so the map is readable without relying on hue.
 */

/** Warm for moves-together, cool for moves-opposite, flat for weak. */
function cellStyle(r: number | null, threshold: number): string {
  if (r === null) return "bg-muted/30 text-muted-foreground";
  const magnitude = Math.abs(r);
  if (magnitude >= threshold) {
    return r > 0
      ? "bg-destructive/25 text-destructive font-bold"
      : "bg-primary/25 text-primary font-bold";
  }
  if (magnitude >= threshold * 0.6) {
    return r > 0 ? "bg-warning/15 text-warning" : "bg-primary/10 text-primary";
  }
  return "bg-muted/40 text-muted-foreground";
}

export function CorrelationHeatMap() {
  const { data, isLoading, isError } = useGetPortfolioCorrelation();

  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Grid3x3 className="h-4 w-4" />Correlation</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Measuring…
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) return null;

  const { symbols, cells, openSymbols, threshold } = data;
  const lookup = new Map(cells.map((c) => [`${c.a}|${c.b}`, c.correlation]));
  const corrOf = (a: string, b: string): number | null =>
    a === b ? 1 : lookup.get(`${a}|${b}`) ?? lookup.get(`${b}|${a}`) ?? null;

  if (symbols.length < 2) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Grid3x3 className="h-4 w-4" />Correlation</CardTitle></CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Correlation needs at least two configured pairs to compare.
        </CardContent>
      </Card>
    );
  }

  const measured = cells.filter((c) => c.correlation !== null).length;
  const held = new Set(openSymbols);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Grid3x3 className="h-4 w-4" />Correlation
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Daily returns, 30-day lookback. Pairs at or above {threshold.toFixed(2)} count as one bet
          for the correlated-exposure cap. Symbols you currently hold are underlined.
        </p>
      </CardHeader>
      <CardContent className="p-3 sm:p-4 pt-0">
        <div className="overflow-x-auto">
          <table className="text-xs font-mono border-separate border-spacing-0.5">
            <thead>
              <tr>
                <th className="p-1" />
                {symbols.map((s) => (
                  <th key={s} className={cn("p-1 font-normal text-muted-foreground text-[10px] whitespace-nowrap", held.has(s) && "underline decoration-primary")}>
                    {s.replace(/USDT$/, "")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {symbols.map((rowSym) => (
                <tr key={rowSym}>
                  <th className={cn("p-1 pr-2 font-normal text-muted-foreground text-[10px] text-right whitespace-nowrap", held.has(rowSym) && "underline decoration-primary")}>
                    {rowSym.replace(/USDT$/, "")}
                  </th>
                  {symbols.map((colSym) => {
                    const r = corrOf(rowSym, colSym);
                    const self = rowSym === colSym;
                    return (
                      <td
                        key={colSym}
                        className={cn(
                          "p-1 text-center rounded min-w-[2.75rem] tabular-nums",
                          self ? "bg-border/40 text-muted-foreground" : cellStyle(r, threshold),
                        )}
                        title={r === null ? `${rowSym} / ${colSym}: insufficient shared history` : `${rowSym} / ${colSym}: ${r.toFixed(2)}`}
                      >
                        {r === null ? "—" : r.toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {measured < cells.length && (
          <p className="text-[11px] text-muted-foreground mt-3">
            {cells.length - measured} of {cells.length} pairs show “—”: not enough shared daily
            history yet to measure them. They are never assumed to be uncorrelated.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

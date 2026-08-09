import { useQuery } from "@tanstack/react-query";
import { getMarketState } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@/components/ui";
import { useSection } from "@/lib/section";
import { cn } from "@/lib/utils";
import { Activity, AlertTriangle, Compass, DatabaseZap, Radar, Waves } from "lucide-react";

interface AvailableState {
  status: "available";
  state: {
    symbol: string;
    dataTimestamp: string;
    fingerprint: string;
    freshness: { status: "fresh" | "stale"; ageMs: number; maximumAgeMs: number };
    dataQuality: { status: "healthy" | "degraded"; issues: string[] };
    observations: {
      lastPrice: number;
      volatility: { atrPercent: number; ratioToBaseline: number; phase: "compression" | "normal" | "expansion" };
      momentum: { longStructureScore: number; shortStructureScore: number };
      liquidity: { volumeRatio: number; proxyStatus: "thin" | "normal" | "elevated" };
      structure: { nearestSupport: number | null; nearestResistance: number | null };
    };
    inferences: {
      regime: string;
      regimeConfidence: number;
      dominantDirection: "bullish" | "bearish" | "neutral";
      anomaly: { detected: boolean; reasonCodes: string[] };
    };
  };
}

interface BlockedState {
  status: "blocked";
  symbol: string;
  observedAt: string;
  issues: Array<{ code: string; detail: string; timeframe?: string }>;
}

type MarketStateResult = AvailableState | BlockedState;

function ageLabel(milliseconds: number): string {
  if (milliseconds < 60_000) return Math.round(milliseconds / 1000) + "s";
  return Math.round(milliseconds / 60_000) + "m";
}

function dominantRegime(states: AvailableState[]): { regime: string; confidence: number } | null {
  if (states.length === 0) return null;
  const scores = new Map<string, { count: number; confidence: number }>();
  for (const item of states) {
    const current = scores.get(item.state.inferences.regime) ?? { count: 0, confidence: 0 };
    current.count++;
    current.confidence += item.state.inferences.regimeConfidence;
    scores.set(item.state.inferences.regime, current);
  }
  const [regime, value] = [...scores.entries()].sort((a, b) => b[1].count - a[1].count || b[1].confidence - a[1].confidence)[0]!;
  return { regime, confidence: value.confidence / value.count };
}

export function MarketOverview() {
  const { section } = useSection();
  const query = useQuery<MarketStateResult[]>({
    queryKey: ["market-state", section],
    refetchInterval: 15_000,
    queryFn: async () => (await getMarketState()) as MarketStateResult[],
  });

  const results = query.data ?? [];
  const available = results.filter((item): item is AvailableState => item.status === "available");
  const blocked = results.filter((item): item is BlockedState => item.status === "blocked");
  const dominant = dominantRegime(available);
  const newestAge = available.length ? Math.min(...available.map((item) => item.state.freshness.ageMs)) : null;
  const averageVolatility = available.length
    ? available.reduce((sum, item) => sum + item.state.observations.volatility.atrPercent, 0) / available.length
    : null;
  const thinMarkets = available.filter((item) => item.state.observations.liquidity.proxyStatus === "thin").length;
  const radar = [...available].sort((a, b) => {
    const scoreA = Math.max(a.state.observations.momentum.longStructureScore, a.state.observations.momentum.shortStructureScore);
    const scoreB = Math.max(b.state.observations.momentum.longStructureScore, b.state.observations.momentum.shortStructureScore);
    return scoreB - scoreA;
  }).slice(0, 8);

  return (
    <section className="space-y-3" aria-labelledby="market-overview-title">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="market-overview-title" className="flex items-center gap-2 text-base font-semibold">
            <Compass className="h-4 w-4 text-primary" />
            Market Overview
          </h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Closed-candle observations and explicit inferences. This surface cannot execute trades.
          </p>
        </div>
        <Badge variant="outline" className="font-mono text-[10px]">MarketState v1 · observational</Badge>
      </div>

      {blocked.length > 0 && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3" role="alert">
          <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Market perception blocked for {blocked.length} symbol{blocked.length === 1 ? "" : "s"}
          </div>
          <div className="mt-2 space-y-1 text-[12px]">
            {blocked.slice(0, 5).map((item) => (
              <div key={item.symbol}>
                <span className="font-mono font-semibold">{item.symbol}</span>
                <span className="text-muted-foreground"> — {item.issues.map((issue) => issue.code).join(", ")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {query.isError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">
          MarketState is unavailable. Existing Brain V0 engine status remains separate.
        </div>
      )}

      {!query.isLoading && !query.isError && available.length === 0 && blocked.length === 0 && (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Market perception will appear after the engine completes a scan.
        </div>
      )}

      {available.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><Activity className="h-3.5 w-3.5" /> Regime</div>
                <div className="mt-2 text-sm font-semibold">{dominant?.regime.replaceAll("_", " ")}</div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">{Math.round((dominant?.confidence ?? 0) * 100)}% inference confidence</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><DatabaseZap className="h-3.5 w-3.5" /> Freshness</div>
                <div className="mt-2 text-sm font-semibold">{newestAge == null ? "—" : ageLabel(newestAge)}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">{available.length} validated symbols</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><Waves className="h-3.5 w-3.5" /> Volatility</div>
                <div className="mt-2 text-sm font-semibold">{averageVolatility == null ? "—" : averageVolatility.toFixed(2) + "% ATR"}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">Observed, not forecast</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><Radar className="h-3.5 w-3.5" /> Liquidity proxy</div>
                <div className={cn("mt-2 text-sm font-semibold", thinMarkets > 0 && "text-warning")}>{thinMarkets} thin</div>
                <div className="mt-1 text-[11px] text-muted-foreground">Volume proxy, not depth</div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Opportunity Radar</CardTitle>
              <p className="text-[11px] text-muted-foreground">Ranks observed structure only. It is not an entry recommendation.</p>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {radar.map((item) => {
                const state = item.state;
                const longScore = state.observations.momentum.longStructureScore;
                const shortScore = state.observations.momentum.shortStructureScore;
                const direction = longScore > shortScore ? "long observation" : shortScore > longScore ? "short observation" : "neutral";
                return (
                  <div key={state.fingerprint} className="rounded-md border border-border/70 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold">{state.symbol}</span>
                      {state.inferences.anomaly.detected && <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-label="Anomaly detected" />}
                    </div>
                    <div className="mt-2 text-[12px]">{direction}</div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      structure {Math.max(longScore, shortScore).toFixed(0)} · {state.inferences.regime.replaceAll("_", " ")}
                    </div>
                    <div className="mt-2 text-[10px] text-muted-foreground">
                      S {state.observations.structure.nearestSupport?.toPrecision(5) ?? "—"} · R {state.observations.structure.nearestResistance?.toPrecision(5) ?? "—"}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}

import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CandlestickSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { AlertTriangle, Loader2 } from "lucide-react";
import { sectionHeaders, useSection } from "@/lib/section";

type RawCandle = [number, number, number, number, number, number];

export function MarketChart({
  symbol,
  marketType,
  stale,
}: {
  symbol: string;
  marketType: string;
  stale: boolean;
}) {
  const { section } = useSection();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const fittedRef = useRef(false);
  const query = useQuery<{ candles: RawCandle[] }>({
    queryKey: ["market-candles", section, symbol, marketType, "dashboard"],
    refetchInterval: 5_000,
    queryFn: async () => {
      const params = new URLSearchParams({ symbol, timeframe: "1m", limit: "180", marketType });
      const response = await fetch(`/api/market/candles?${params}`, {
        credentials: "same-origin",
        headers: sectionHeaders(),
      });
      if (!response.ok) throw new Error("Market candles are unavailable.");
      return response.json() as Promise<{ candles: RawCandle[] }>;
    },
  });

  useEffect(() => {
    if (!containerRef.current) return;
    const foreground = getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground").trim();
    const border = getComputedStyle(document.documentElement).getPropertyValue("--border").trim();
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: foreground ? `hsl(${foreground})` : "#A2B2AC",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: border ? `hsl(${border} / .22)` : "rgba(162,178,172,.08)" },
        horzLines: { color: border ? `hsl(${border} / .22)` : "rgba(162,178,172,.08)" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#34D399",
      downColor: "#FB7185",
      wickUpColor: "#34D399",
      wickDownColor: "#FB7185",
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    fittedRef.current = false;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [symbol]);

  useEffect(() => {
    if (!seriesRef.current || !query.data?.candles.length) return;
    seriesRef.current.setData(
      query.data.candles.map((candle) => ({
        time: Math.floor(candle[0] / 1_000) as UTCTimestamp,
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
      })),
    );
    if (!fittedRef.current) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [query.data]);

  const summary = useMemo(() => {
    const candles = query.data?.candles ?? [];
    if (!candles.length) return null;
    const first = candles[0]!;
    const last = candles.at(-1)!;
    const high = Math.max(...candles.map((candle) => candle[2]));
    const low = Math.min(...candles.map((candle) => candle[3]));
    return { open: first[1], close: last[4], high, low, observedAt: new Date(last[0]).toISOString() };
  }, [query.data]);

  return (
    <div>
      {stale && (
        <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning" role="alert">
          <AlertTriangle className="h-3.5 w-3.5" /> Market data is stale. Do not treat this chart as current.
        </div>
      )}
      <div className="relative h-[320px] min-h-64 sm:h-[420px]">
        <div ref={containerRef} className="absolute inset-0" aria-hidden="true" />
        {query.isLoading && (
          <div className="absolute inset-0 grid place-items-center bg-background/40" role="status">
            <span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading validated candles</span>
          </div>
        )}
        {query.isError && (
          <div className="absolute inset-0 grid place-items-center bg-background/70 p-6 text-center text-sm text-destructive" role="alert">
            Market candles could not be loaded. This is an unavailable state, not an empty market.
          </div>
        )}
      </div>
      <details className="border-t px-4 py-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">Accessible chart summary</summary>
        {summary ? (
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div><dt>Open</dt><dd className="font-mono text-foreground">{summary.open}</dd></div>
            <div><dt>Close</dt><dd className="font-mono text-foreground">{summary.close}</dd></div>
            <div><dt>High</dt><dd className="font-mono text-foreground">{summary.high}</dd></div>
            <div><dt>Low</dt><dd className="font-mono text-foreground">{summary.low}</dd></div>
            <div><dt>Last candle</dt><dd className="font-mono text-foreground">{new Date(summary.observedAt).toLocaleString()}</dd></div>
          </dl>
        ) : (
          <p className="mt-2">No validated candles are available.</p>
        )}
      </details>
    </div>
  );
}

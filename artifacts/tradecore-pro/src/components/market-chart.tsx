import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { useQuery } from "@tanstack/react-query";
import {
  CandlestickSeries,
  HistogramSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { AlertTriangle, Loader2 } from "lucide-react";
import { sectionHeaders, useSection } from "@/lib/section";
import { formatTradingNumber } from "@/components/dashboard-summary";
import { cn } from "@/lib/utils";

type RawCandle = [number, number, number, number, number, number];
const intervals = ["1m", "3m", "5m", "15m", "1h"] as const;

function validatedCandles(payload: unknown): RawCandle[] {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("candles" in payload) ||
    !Array.isArray(payload.candles)
  )
    throw new Error("Invalid market candle response.");
  const candles = new Map<number, RawCandle>();
  for (const candle of payload.candles) {
    if (
      !Array.isArray(candle) ||
      candle.length < 6 ||
      !candle
        .slice(0, 6)
        .every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ) ||
      candle[0] <= 0 ||
      candle[1] <= 0 ||
      candle[4] <= 0 ||
      candle[3] <= 0 ||
      candle[2] < Math.max(candle[1], candle[4], candle[3]) ||
      candle[3] > Math.min(candle[1], candle[4]) ||
      candle[5] < 0
    )
      throw new Error("Market candles failed validation.");
    candles.set(Math.floor(candle[0] / 1000), candle.slice(0, 6) as RawCandle);
  }
  return [...candles.values()].sort((a, b) => a[0] - b[0]);
}

export function MarketChart({
  symbol,
  marketType,
  stale,
  position,
}: {
  symbol: string;
  marketType: string;
  stale: boolean;
  position?: { entryPrice: number; stopLoss: number; takeProfit: number };
}) {
  const { section } = useSection();
  const { resolvedTheme } = useTheme();
  const [timeframe, setTimeframe] = useState<(typeof intervals)[number]>("5m");
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fittedRef = useRef(false);
  const query = useQuery({
    queryKey: [
      "market-candles",
      section,
      symbol,
      marketType,
      timeframe,
      "dashboard",
    ],
    refetchInterval: 5_000,
    queryFn: async () => {
      const params = new URLSearchParams({
        symbol,
        timeframe,
        limit: "180",
        marketType,
      });
      const response = await fetch(`/api/market/candles?${params}`, {
        credentials: "same-origin",
        headers: sectionHeaders(),
      });
      if (!response.ok) throw new Error("Market candles are unavailable.");
      return validatedCandles(await response.json());
    },
  });
  useEffect(() => {
    if (!containerRef.current) return;
    const colors = getComputedStyle(document.documentElement);
    const border = colors.getPropertyValue("--border").trim();
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: resolvedTheme === "dark" ? "#b2c4bc" : "#53635c",
        fontFamily: "Inter, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: `hsl(${border} / .18)` },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.2 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#059669",
      downColor: "#e05265",
      wickUpColor: "#059669",
      wickDownColor: "#e05265",
      borderVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume
      .priceScale()
      .applyOptions({ scaleMargins: { top: 0.88, bottom: 0 }, visible: false });
    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;
    fittedRef.current = false;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
    };
  }, [symbol, marketType, timeframe, section, resolvedTheme]);
  useEffect(() => {
    const candles = query.isError ? [] : (query.data ?? []);
    if (!seriesRef.current) return;
    seriesRef.current.setData(
      candles.map((candle) => ({
        time: Math.floor(candle[0] / 1000) as UTCTimestamp,
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
      })),
    );
    volumeRef.current?.setData(
      candles.map((candle) => ({
        time: Math.floor(candle[0] / 1000) as UTCTimestamp,
        value: candle[5],
        color:
          candle[4] >= candle[1]
            ? "rgba(5,150,105,.22)"
            : "rgba(224,82,101,.22)",
      })),
    );
    const price = candles.at(-1)?.[4];
    if (price && price < 1) {
      const precision = Math.min(
        12,
        Math.max(4, Math.ceil(-Math.log10(price)) + 3),
      );
      seriesRef.current.applyOptions({
        priceFormat: { type: "price", precision, minMove: 10 ** -precision },
      });
    }
    if (!fittedRef.current && candles.length) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [
    query.data,
    query.isError,
    symbol,
    marketType,
    timeframe,
    section,
    resolvedTheme,
  ]);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !position) return;
    const lines = [
      { price: position.entryPrice, color: "#64748b", title: "Entry" },
      { price: position.stopLoss, color: "#e05265", title: "Stop" },
      { price: position.takeProfit, color: "#059669", title: "Target" },
    ]
      .filter((line) => Number.isFinite(line.price) && line.price > 0)
      .map((line) =>
        series.createPriceLine({
          ...line,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
        }),
      );
    return () => {
      if (seriesRef.current === series)
        lines.forEach((line) => series.removePriceLine(line));
    };
  }, [
    position?.entryPrice,
    position?.stopLoss,
    position?.takeProfit,
    symbol,
    marketType,
    timeframe,
    section,
    resolvedTheme,
  ]);
  const summary = useMemo(() => {
    if (query.isError || !query.data?.length) return null;
    const first = query.data[0]!;
    const last = query.data.at(-1)!;
    return {
      open: first[1],
      close: last[4],
      high: Math.max(...query.data.map((c) => c[2])),
      low: Math.min(...query.data.map((c) => c[3])),
      observedAt: new Date(last[0]).toISOString(),
    };
  }, [query.data, query.isError]);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <div>
          <span className="text-lg font-semibold">
            {summary ? formatTradingNumber(summary.close) : "Price unavailable"}
          </span>
          <span className="ml-2 text-xs text-muted-foreground">
            {stale ? "Stale quote" : "Last candle close"}
          </span>
        </div>
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="Chart timeframe"
        >
          {intervals.map((interval) => (
            <button
              key={interval}
              type="button"
              aria-pressed={timeframe === interval}
              onClick={() => setTimeframe(interval)}
              className={cn(
                "min-h-9 min-w-9 rounded-md px-2 text-xs text-muted-foreground",
                timeframe === interval
                  ? "bg-primary/10 font-semibold text-primary"
                  : "hover:bg-muted",
              )}
            >
              {interval}
            </button>
          ))}
        </div>
      </div>
      {stale && (
        <div
          className="flex items-center gap-2 border-y border-warning/30 bg-warning/5 px-4 py-2 text-xs text-warning"
          role="alert"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Market data is stale or unavailable. Do not treat this chart as
          current.
        </div>
      )}
      <div className="relative h-[280px] sm:h-[320px]">
        <div
          ref={containerRef}
          className="absolute inset-0"
          aria-hidden="true"
        />
        {query.isLoading && (
          <div
            className="absolute inset-0 grid place-items-center bg-surface/80"
            role="status"
          >
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading validated candles
            </span>
          </div>
        )}
        {query.isError && (
          <div
            className="absolute inset-0 grid place-items-center bg-surface/95 p-6 text-center text-sm text-destructive"
            role="alert"
          >
            Market candles could not be loaded. {query.error.message}
          </div>
        )}
        {!query.isLoading && !query.isError && !summary && (
          <div
            className="absolute inset-0 grid place-items-center bg-surface/90 text-sm text-muted-foreground"
            role="status"
          >
            No validated candles are available.
          </div>
        )}
      </div>
      <details className="border-t px-5 py-2.5 text-xs text-muted-foreground">
        <summary className="min-h-6 cursor-pointer font-medium">
          Accessible chart summary
        </summary>
        {summary ? (
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              ["Open", summary.open],
              ["Close", summary.close],
              ["High", summary.high],
              ["Low", summary.low],
              ["Last candle", new Date(summary.observedAt).toLocaleString()],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="mt-1 text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-2">No validated candles are available.</p>
        )}
      </details>
    </div>
  );
}

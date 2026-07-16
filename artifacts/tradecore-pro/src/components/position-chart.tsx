import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createChart, CandlestickSeries, LineStyle,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp,
} from "lightweight-charts";
import { Loader2 } from "lucide-react";

/**
 * Live candlestick chart for one open position (tap a position card to open).
 * 1-minute candles from the SAME feed the engine trades on, refreshed every
 * 5s, with the position's levels drawn as horizontal price lines: entry
 * (neutral), stop loss (red), take profit (green), and the TP1 waypoint
 * (dashed green) while it's still pending.
 */

// Canvas can't read CSS variables — concrete colors matching the dark theme.
const COLORS = {
  up: "#22c55e",
  down: "#ef4444",
  entry: "#94a3b8",
  sl: "#ef4444",
  tp: "#22c55e",
  grid: "rgba(148, 163, 184, 0.08)",
  text: "#94a3b8",
};

interface PositionChartProps {
  symbol: string;
  marketType: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  tp1Price: number | null;
  tp1Filled: boolean;
}

type RawCandle = [number, number, number, number, number, number];

export function PositionChart(props: PositionChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const fittedRef = useRef(false);

  const { data, isLoading, isError } = useQuery<{ candles: RawCandle[] }>({
    queryKey: ["market-candles", props.symbol, props.marketType],
    refetchInterval: 5000,
    queryFn: async () => {
      const params = new URLSearchParams({
        symbol: props.symbol, timeframe: "1m", limit: "180", marketType: props.marketType,
      });
      const res = await fetch(`/api/market/candles?${params}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error("candle fetch failed");
      return res.json();
    },
  });

  // Create the chart once.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: COLORS.text, fontSize: 10 },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { labelVisible: true }, vertLine: { labelVisible: false } },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.up, downColor: COLORS.down,
      wickUpColor: COLORS.up, wickDownColor: COLORS.down,
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    fittedRef.current = false;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  // Feed candles into the series as they refresh.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !data?.candles?.length) return;
    series.setData(
      data.candles.map((c) => ({
        time: Math.floor(c[0] / 1000) as UTCTimestamp,
        open: c[1], high: c[2], low: c[3], close: c[4],
      })),
    );
    // Fit once on first load; afterwards leave the user's zoom/pan alone.
    if (!fittedRef.current && chartRef.current) {
      chartRef.current.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [data]);

  // Draw the position's levels; re-draw if they move (trailing/break-even).
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];

    const add = (price: number, color: string, title: string, style: LineStyle = LineStyle.Solid) =>
      priceLinesRef.current.push(
        series.createPriceLine({ price, color, title, lineWidth: 1, lineStyle: style, axisLabelVisible: true }),
      );

    add(props.entryPrice, COLORS.entry, `Entry ${props.side === "short" ? "▼" : "▲"}`);
    add(props.stopLossPrice, COLORS.sl, "SL");
    add(props.takeProfitPrice, COLORS.tp, "TP");
    if (props.tp1Price != null && !props.tp1Filled) add(props.tp1Price, COLORS.tp, "TP1", LineStyle.Dashed);
  }, [props.entryPrice, props.stopLossPrice, props.takeProfitPrice, props.tp1Price, props.tp1Filled, props.side, data]);

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-background/60 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        <span>{props.symbol} · 1m · live</span>
        <span>
          {props.side} {props.quantity} @ {props.entryPrice}
        </span>
      </div>
      <div className="relative h-56 sm:h-64">
        <div ref={containerRef} className="absolute inset-0" />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {isError && (
          <div className="absolute inset-0 flex items-center justify-center text-xs font-mono text-destructive">
            Couldn't load candles for {props.symbol}
          </div>
        )}
      </div>
    </div>
  );
}

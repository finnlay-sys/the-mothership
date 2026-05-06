// Live candlestick chart powered by lightweight-charts (TradingView).
// Phase 3 will inject markers and price lines via the exposed chartHandleRef
// (IChartApi + ISeriesApi<'Candlestick'>) — do not refactor the ref shape
// without updating the downstream marker hook.
import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import {
  createChart,
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type UTCTimestamp,
} from "lightweight-charts";

// IMPORTANT: these fields are GETTER-BACKED on the actual handle returned by
// useImperativeHandle below — they always read the current chart/series refs.
// Do not refactor the implementation back to a plain snapshot object: the
// chart instances are created inside a useEffect that runs AFTER the handle
// is committed, so a snapshot would freeze in `null` until MarketChart next
// re-renders, leaving consumers (e.g. useChartAnnotations) unable to draw.
export type MarketChartHandle = {
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
};

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type MarketChartProps = {
  symbol: string;
  interval: string;
  // Latest mark price + ms timestamp from the existing market SSE feed.
  // Used to update the rightmost candle in real time without opening a
  // second connection.
  latestPrice?: number | null;
  latestTimestamp?: number | null;
  onError?: (msg: string | null) => void;
};

const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

function bucketStart(tsSec: number, intervalSec: number): number {
  return Math.floor(tsSec / intervalSec) * intervalSec;
}

export const MarketChart = forwardRef<MarketChartHandle, MarketChartProps>(
  function MarketChart({ symbol, interval, latestPrice, latestTimestamp, onError }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const lastBarRef = useRef<CandlestickData<UTCTimestamp> | null>(null);

    // Live, getter-backed handle. The chart and series are constructed inside
    // useEffect, which runs AFTER React has read this object during the commit
    // phase — so a snapshot like `{ chart: chartRef.current, series: seriesRef.current }`
    // would freeze in `null` until the next render of MarketChart (which only
    // happens incidentally, e.g. when a market-price tick arrives). Getters
    // make the consumer always read whatever the refs currently point at,
    // including null when the chart is mid-rebuild after a symbol/interval
    // change. Empty deps so the handle object identity is stable.
    useImperativeHandle(
      ref,
      () => ({
        get chart() { return chartRef.current; },
        get series() { return seriesRef.current; },
      }),
      [],
    );

    // Initial fetch + chart construction whenever symbol or interval changes.
    useEffect(() => {
      if (!containerRef.current) return;
      let cancelled = false;
      const container = containerRef.current;

      // Read CSS variables so the chart picks up the project's terminal theme.
      const css = getComputedStyle(document.documentElement);
      const cssVar = (name: string, fallback: string) => {
        const v = css.getPropertyValue(name).trim();
        return v ? `hsl(${v})` : fallback;
      };
      const cardBg = cssVar("--card", "#0a0a0a");
      const fg = cssVar("--foreground", "#e5e5e5");
      const muted = cssVar("--muted-foreground", "#737373");
      const border = cssVar("--border", "#262626");
      const up = cssVar("--chart-2", "#22d3ee");
      const down = cssVar("--destructive", "#ef4444");

      // All times shown in UTC/GMT, not local timezone — traders expect
      // exchange-aligned timestamps. lightweight-charts defaults to local
      // time, so we override both the axis tick labels and the crosshair
      // tooltip via UTC date methods.
      const pad = (n: number) => String(n).padStart(2, "0");
      const monthNames = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
      const tickMarkFormatter = (time: number | { year: number; month: number; day: number }, tickType: number): string => {
        // Business-day ticks come in as { year, month, day } (no time);
        // intraday ticks come in as a UNIX seconds number.
        if (typeof time !== "number") {
          return `${pad(time.day)} ${monthNames[time.month - 1] ?? ""}`;
        }
        const d = new Date(time * 1000);
        // tickType: 0=Year 1=Month 2=DayOfMonth 3=Time 4=TimeWithSeconds
        if (tickType >= 3) {
          return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        }
        if (tickType === 2) return `${pad(d.getUTCDate())} ${monthNames[d.getUTCMonth()]}`;
        if (tickType === 1) return `${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
        return String(d.getUTCFullYear());
      };
      const timeFormatter = (time: number | { year: number; month: number; day: number }): string => {
        if (typeof time !== "number") {
          return `${time.year}-${pad(time.month)}-${pad(time.day)} UTC`;
        }
        const d = new Date(time * 1000);
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
      };

      const chart = createChart(container, {
        width: container.clientWidth,
        // Fill the parent in BOTH dimensions. Previously height was hardcoded
        // to 360px, leaving large empty areas inside taller widgets and the
        // fullscreen overlay. The wrapping div in mission-detail.tsx now sets
        // an explicit h-full so clientHeight reflects available vertical space.
        height: container.clientHeight || 360,
        layout: {
          background: { color: cardBg },
          textColor: fg,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: border },
          horzLines: { color: border },
        },
        rightPriceScale: { borderColor: border },
        timeScale: {
          borderColor: border,
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: tickMarkFormatter as never,
        },
        localization: {
          timeFormatter: timeFormatter as never,
        },
        crosshair: { mode: 1 },
      });
      chartRef.current = chart;

      const series = chart.addSeries(CandlestickSeries, {
        upColor: up,
        downColor: down,
        wickUpColor: up,
        wickDownColor: down,
        borderVisible: false,
      });
      seriesRef.current = series;

      const ro = new ResizeObserver(() => {
        if (chartRef.current && containerRef.current) {
          // applyOptions can throw "Object is disposed" if the chart was
          // remove()'d in the same frame as a queued resize callback (race
          // between cleanup and ResizeObserver flush). Swallow it — the chart
          // is gone and there's nothing to size.
          try {
            chartRef.current.applyOptions({
              width: containerRef.current.clientWidth,
              height: containerRef.current.clientHeight,
            });
          } catch { /* chart disposed */ }
        }
      });
      ro.observe(container);

      (async () => {
        try {
          const base = import.meta.env.BASE_URL.replace(/\/$/, "");
          const url = `${base}/api/market/${encodeURIComponent(symbol)}/candles?interval=${encodeURIComponent(interval)}&limit=500`;
          const r = await fetch(url);
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body?.error || `HTTP ${r.status}`);
          }
          const data = (await r.json()) as { candles: Candle[] };
          if (cancelled) return;
          const bars: CandlestickData<UTCTimestamp>[] = data.candles.map((c) => ({
            time: c.time as UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }));
          series.setData(bars);
          lastBarRef.current = bars[bars.length - 1] ?? null;
          chart.timeScale().fitContent();
          onError?.(null);
        } catch (e) {
          if (!cancelled) onError?.(e instanceof Error ? e.message : "chart load failed");
        }
      })();

      return () => {
        cancelled = true;
        ro.disconnect();
        chart.remove();
        chartRef.current = null;
        seriesRef.current = null;
        lastBarRef.current = null;
      };
    }, [symbol, interval, onError]);

    // Live tick: mutate the rightmost bar from the existing SSE mark price.
    // When the wall-clock crosses into the next interval bucket, append a
    // fresh bar instead of stretching the previous one.
    useEffect(() => {
      const series = seriesRef.current;
      if (!series || latestPrice == null || !Number.isFinite(latestPrice) || latestTimestamp == null) {
        return;
      }
      const intervalSec = INTERVAL_SECONDS[interval] ?? 60;
      const tsSec = Math.floor(latestTimestamp / 1000);
      const bucket = bucketStart(tsSec, intervalSec) as UTCTimestamp;
      const last = lastBarRef.current;

      if (!last) {
        const fresh: CandlestickData<UTCTimestamp> = {
          time: bucket,
          open: latestPrice,
          high: latestPrice,
          low: latestPrice,
          close: latestPrice,
        };
        series.update(fresh);
        lastBarRef.current = fresh;
        return;
      }

      if (bucket > (last.time as number)) {
        const fresh: CandlestickData<UTCTimestamp> = {
          time: bucket,
          open: last.close,
          high: Math.max(last.close, latestPrice),
          low: Math.min(last.close, latestPrice),
          close: latestPrice,
        };
        series.update(fresh);
        lastBarRef.current = fresh;
      } else {
        const updated: CandlestickData<UTCTimestamp> = {
          time: last.time,
          open: last.open,
          high: Math.max(last.high, latestPrice),
          low: Math.min(last.low, latestPrice),
          close: latestPrice,
        };
        series.update(updated);
        lastBarRef.current = updated;
      }
    }, [latestPrice, latestTimestamp, interval]);

    // h-full so the chart fills its parent in both dimensions; the parent
    // controls actual height (widget body or fullscreen overlay flex slot).
    return <div ref={containerRef} data-testid="market-chart" className="w-full h-full min-h-[240px]" />;
  },
);

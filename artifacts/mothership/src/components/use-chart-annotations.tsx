// Bridges Synthesizer/Queen ChartAnnotation payloads to the lightweight-charts
// IChartApi instance held by MarketChart. Each render reconciles the chart to
// match exactly the annotations prop:
//   - markers are de-duped by (timeUtcSec|kind|text) and re-set as a whole
//   - price lines diff against the previously rendered set; lines whose key is
//     no longer present are removed via series.removePriceLine. This is the
//     supersession contract: a fresh debate cycle's annotation payload replaces
//     stale lines instead of accumulating.
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  createSeriesMarkers,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type IPriceLine,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { MarketChartHandle } from "./market-chart";

export type AnnMarker = {
  kind: "entry" | "exit" | "stop" | "take_profit" | "signal" | "note";
  timeUtcSec: number;
  position: "aboveBar" | "belowBar" | "inBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  color: "cyan" | "red" | "amber" | "muted";
  text: string;
};

export type AnnPriceLine = {
  kind: "entry" | "stop" | "take_profit" | "level";
  price: number;
  color: "cyan" | "red" | "amber" | "muted";
  label: string;
};

export type ChartAnnotations = {
  markers: AnnMarker[];
  priceLines: AnnPriceLine[];
};

const COLOR_HEX: Record<AnnMarker["color"], string> = {
  cyan: "#22d3ee",
  red: "#ef4444",
  amber: "#fbbf24",
  muted: "#737373",
};

function markerKey(m: AnnMarker): string {
  return `${m.timeUtcSec}|${m.kind}|${m.text}`;
}

// Includes color so style updates are treated as new lines (old gets removed).
function priceLineKey(p: AnnPriceLine): string {
  return `${p.kind}|${p.price.toFixed(6)}|${p.label}|${p.color}`;
}

function toLwMarker(m: AnnMarker): SeriesMarker<Time> {
  return {
    time: m.timeUtcSec as UTCTimestamp,
    position: m.position,
    color: COLOR_HEX[m.color],
    shape: m.shape,
    text: m.text,
  };
}

export function useChartAnnotations(
  handleRef: RefObject<MarketChartHandle | null>,
  annotations: ChartAnnotations,
  resetKey: string | number,
) {
  const linesByKey = useRef<Map<string, IPriceLine>>(new Map());
  const markersPlugin = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lastResetKey = useRef<string | number>(resetKey);
  const [, forceTick] = useState(0);
  // Bumped whenever the chart series transitions from null -> ready so the
  // drawing effect re-runs against the now-mounted chart. Without this, an
  // annotation SSE that fires before the chart finishes loading is silently
  // dropped (ref mutations don't trigger effects).
  const [chartReadyTick, setChartReadyTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      if (handleRef.current?.series) {
        setChartReadyTick((t) => t + 1);
        return;
      }
      requestAnimationFrame(poll);
    };
    poll();
    return () => { cancelled = true; };
  }, [handleRef, resetKey]);

  // Reset on symbol/interval change — chart is rebuilt and existing handles
  // become stale.
  useEffect(() => {
    if (lastResetKey.current !== resetKey) {
      linesByKey.current.clear();
      markersPlugin.current = null;
      lastResetKey.current = resetKey;
    }
  }, [resetKey]);

  useEffect(() => {
    const series = handleRef.current?.series;
    if (!series) return;
    void chartReadyTick;

    // ----- Markers: re-set the entire collection (de-duped + sorted) -----
    const markerMap = new Map<string, AnnMarker>();
    for (const m of annotations.markers) markerMap.set(markerKey(m), m);
    const sorted = Array.from(markerMap.values())
      .sort((a, b) => a.timeUtcSec - b.timeUtcSec)
      .map(toLwMarker);
    if (!markersPlugin.current && sorted.length > 0) {
      markersPlugin.current = createSeriesMarkers(series, sorted);
    } else if (markersPlugin.current) {
      try { markersPlugin.current.setMarkers(sorted); } catch { /* noop */ }
    }

    // ----- Price lines: diff against rendered set; remove stale, add new -----
    const desired = new Map<string, AnnPriceLine>();
    for (const p of annotations.priceLines) desired.set(priceLineKey(p), p);

    // Remove stale
    for (const [key, line] of linesByKey.current.entries()) {
      if (!desired.has(key)) {
        try { series.removePriceLine(line); } catch { /* noop */ }
        linesByKey.current.delete(key);
      }
    }
    // Add new
    for (const [key, p] of desired.entries()) {
      if (linesByKey.current.has(key)) continue;
      try {
        const line = series.createPriceLine({
          price: p.price,
          color: COLOR_HEX[p.color],
          lineWidth: 1,
          lineStyle: 2, // dashed
          axisLabelVisible: true,
          title: p.label,
        });
        linesByKey.current.set(key, line);
      } catch { /* chart may be disposing */ }
    }

    // Trigger a re-render so derived counts (markerCount/priceLineCount) refresh.
    forceTick((t) => t + 1);
  }, [annotations, handleRef, chartReadyTick]);

  const clear = () => {
    const series = handleRef.current?.series;
    if (markersPlugin.current) {
      try { markersPlugin.current.setMarkers([]); } catch { /* noop */ }
    }
    if (series) {
      for (const line of linesByKey.current.values()) {
        try { series.removePriceLine(line); } catch { /* noop */ }
      }
    }
    linesByKey.current.clear();
  };

  // Counts reflect the current annotations prop after de-dup, not internal state.
  const markerCount = new Set(annotations.markers.map(markerKey)).size;
  const priceLineCount = new Set(annotations.priceLines.map(priceLineKey)).size;

  return { markerCount, priceLineCount, clear };
}

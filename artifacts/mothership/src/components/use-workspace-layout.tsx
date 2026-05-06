import { useCallback, useEffect, useRef, useState } from "react";
import type { WidgetBox } from "./mission-widget";

export type WidgetId = "chart" | "feed" | "queen";
export type WorkspaceLayout = Record<WidgetId, WidgetBox>;

const STORAGE_PREFIX = "mothership.layout.v1.";

function defaultLayout(width: number, height: number): WorkspaceLayout {
  const w = Math.max(width, 800);
  const h = Math.max(height, 480);
  const gap = 8;
  const feedW = Math.round(w * 0.38);
  const leftW = w - feedW - gap * 3;
  const chartH = Math.round(h * 0.6);
  const queenH = h - chartH - gap * 3;
  return {
    chart: { x: gap, y: gap, w: leftW, h: chartH, z: 1 },
    queen: { x: gap, y: gap * 2 + chartH, w: leftW, h: queenH, z: 1 },
    feed:  { x: gap * 2 + leftW, y: gap, w: feedW, h: h - gap * 2, z: 1 },
  };
}

function readStored(missionId: number): WorkspaceLayout | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${missionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkspaceLayout>;
    if (!parsed.chart || !parsed.feed || !parsed.queen) return null;
    return parsed as WorkspaceLayout;
  } catch {
    return null;
  }
}

function writeStored(missionId: number, layout: WorkspaceLayout) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${missionId}`, JSON.stringify(layout));
  } catch {
    /* quota / disabled — ignore */
  }
}

export function useWorkspaceLayout(missionId: number, width: number, height: number) {
  const [layout, setLayout] = useState<WorkspaceLayout | null>(null);
  const zCounterRef = useRef(10);
  const initializedFor = useRef<number | null>(null);

  useEffect(() => {
    if (!missionId || width <= 0 || height <= 0) return;
    if (initializedFor.current === missionId && layout) return;
    const stored = readStored(missionId);
    setLayout(stored ?? defaultLayout(width, height));
    initializedFor.current = missionId;
    // recompute max z so future focuses stack above any persisted z values
    if (stored) {
      const maxZ = Math.max(stored.chart.z, stored.feed.z, stored.queen.z, 10);
      zCounterRef.current = maxZ + 1;
    } else {
      zCounterRef.current = 10;
    }
  }, [missionId, width, height, layout]);

  const updateBox = useCallback(
    (id: WidgetId, box: WidgetBox) => {
      setLayout((prev) => {
        if (!prev) return prev;
        const next = { ...prev, [id]: box };
        writeStored(missionId, next);
        return next;
      });
    },
    [missionId],
  );

  const bringToFront = useCallback(
    (id: WidgetId) => {
      setLayout((prev) => {
        if (!prev) return prev;
        const maxZ = Math.max(prev.chart.z, prev.feed.z, prev.queen.z);
        // Already strictly on top — skip the write to avoid storage churn on every click.
        if (prev[id].z > prev.chart.z && prev[id].z > prev.feed.z && prev[id].z > prev.queen.z) {
          return prev;
        }
        const newZ = Math.max(maxZ, zCounterRef.current) + 1;
        zCounterRef.current = newZ;
        const next = { ...prev, [id]: { ...prev[id], z: newZ } };
        writeStored(missionId, next);
        return next;
      });
    },
    [missionId],
  );

  const reset = useCallback(() => {
    if (typeof window !== "undefined") {
      try { window.localStorage.removeItem(`${STORAGE_PREFIX}${missionId}`); } catch { /* noop */ }
    }
    zCounterRef.current = 10;
    setLayout(defaultLayout(width, height));
  }, [missionId, width, height]);

  return { layout, updateBox, bringToFront, reset };
}

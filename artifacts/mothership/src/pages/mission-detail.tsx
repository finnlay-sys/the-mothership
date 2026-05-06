import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Layout } from "@/components/layout";
import { StatusBadge } from "@/components/status-badge";
import { MarketChart, type MarketChartHandle } from "@/components/market-chart";
import { useChartAnnotations, type ChartAnnotations } from "@/components/use-chart-annotations";
import { MissionWidget } from "@/components/mission-widget";
import { useWorkspaceLayout } from "@/components/use-workspace-layout";
import {
  useGetMission,
  useGetMissionStatus,
  useGetMissionReasoningPackets,
  useQueenApprove,
  useQueenVeto,
  useQueenIntervene,
  useKillMission,
  useExecuteMission,
  useKillMissionExecution,
  useGetMissionExecution,
  useGetMissionLedger,
  useVerifyMissionLedger,
} from "@workspace/api-client-react";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Play, ShieldAlert, Check, X, Shield, Activity, Crown, Sword, Brain, Zap, Square, LayoutGrid, Copy, Maximize2, Minimize2, Database, ShieldCheck, Download } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

type StreamEvent = {
  type:
    | "worker_proposal"
    | "observer_audit"
    | "queen_checkpoint"
    | "queen_guidance"
    | "cycle_complete"
    | "chart_annotation"
    | "cost_tick"
    | "deadlock"
    | "done"
    | "error";
  data: any;
};

// Format USD spend with adaptive precision: micro-charges show 4 decimals so
// the operator can see the per-call deltas; once you cross a dollar 2dp is
// fine. Shown live in the header next to CYCLES.
function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "$0.0000";
  if (v >= 10) return `$${v.toFixed(2)}`;
  if (v >= 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

// Shared chart header controls — interval picker, annotation counts, CLEAR,
// and the fullscreen toggle. Rendered in both the windowed widget header and
// the fullscreen overlay so the operator gets the same controls regardless of
// which view they're in.
const CHART_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;

function ChartControls({
  chartInterval,
  setChartInterval,
  markerCount,
  priceLineCount,
  onClear,
  onToggleFullscreen,
  isFullscreen,
}: {
  chartInterval: string;
  setChartInterval: (v: string) => void;
  markerCount: number;
  priceLineCount: number;
  onClear: () => void;
  onToggleFullscreen: () => void;
  isFullscreen: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-0.5" data-testid="chart-interval-selector">
        {CHART_INTERVALS.map((iv) => (
          <button
            key={iv}
            type="button"
            data-testid={`btn-interval-${iv}`}
            onClick={() => setChartInterval(iv)}
            className={`px-1.5 py-0.5 font-mono text-[10px] tracking-widest border rounded-sm uppercase transition-colors ${
              chartInterval === iv
                ? "border-primary/60 text-primary bg-primary/10"
                : "border-border text-muted-foreground hover:text-primary hover:border-primary/40"
            }`}
          >
            {iv}
          </button>
        ))}
      </div>
      <span
        className="font-mono text-[10px] tracking-widest text-muted-foreground hidden lg:inline"
        data-testid="chart-annotation-counts"
      >
        {markerCount}M · {priceLineCount}L
      </span>
      <button
        type="button"
        data-testid="btn-clear-annotations"
        onClick={onClear}
        className="px-2 py-0.5 font-mono text-[10px] tracking-widest border border-border rounded-sm uppercase text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors"
      >
        CLEAR
      </button>
      <button
        type="button"
        data-testid="btn-toggle-chart-fullscreen"
        onClick={onToggleFullscreen}
        className="inline-flex items-center justify-center w-6 h-6 rounded-sm border border-border text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors"
        title={isFullscreen ? "Exit fullscreen (Esc)" : "Open chart fullscreen"}
        aria-label={isFullscreen ? "Exit chart fullscreen" : "Open chart fullscreen"}
      >
        {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

// Per-packet token + cost footer. Renders nothing when usage was not captured
// (older packets, or system/intervention rows that didn't go through an LLM).
function PacketTokensLine({
  packet,
}: {
  packet: {
    tokensIn?: number | null;
    tokensOut?: number | null;
    reasoningTokens?: number | null;
    costUsd?: number | null;
    durationMs?: number | null;
  };
}) {
  if (
    packet.tokensIn == null &&
    packet.tokensOut == null &&
    packet.costUsd == null &&
    packet.durationMs == null
  ) {
    return null;
  }
  const tIn = packet.tokensIn ?? 0;
  const tOut = packet.tokensOut ?? 0;
  const tReason = packet.reasoningTokens ?? 0;
  const cost = packet.costUsd ?? 0;
  const dur = packet.durationMs ?? 0;
  // <1000 ms → "740ms", otherwise "2.4s" — keeps the line compact while
  // making it obvious which agent is the latency hog inside a cycle.
  const durLabel = dur > 0
    ? (dur < 1000 ? `${Math.round(dur)}ms` : `${(dur / 1000).toFixed(1)}s`)
    : null;
  return (
    <div
      className="mt-2 pt-2 border-t border-border/40 font-mono text-[10px] tracking-widest text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5"
      data-testid="packet-tokens-line"
      title={`Reasoning tokens are billed as output. gpt-5-mini · $0.25/M in · $2/M out`}
    >
      <span>TOKENS · IN {tIn.toLocaleString()} · OUT {tOut.toLocaleString()}{tReason > 0 ? ` (${tReason.toLocaleString()} R)` : ""}</span>
      {durLabel && (
        <span data-testid="packet-duration" className="text-chart-2/80">⏱ {durLabel}</span>
      )}
      <span className="text-foreground/70">{fmtUsd(cost)}</span>
    </div>
  );
}

const AGENT_META: Record<string, { icon: any; color: string; label: string }> = {
  STRATEGIST: { icon: Brain, color: "chart-4", label: "STRATEGIST" },
  ADVERSARY: { icon: Sword, color: "chart-1", label: "ADVERSARY" },
  SYNTHESIZER: { icon: Zap, color: "chart-2", label: "SYNTHESIZER" },
};

export function MissionDetail() {
  const { id: idStr } = useParams();
  const id = parseInt(idStr || "0", 10);

  const { data: mission, isLoading: missionLoading, refetch: refetchMission } = useGetMission(id, { query: { enabled: !!id, queryKey: ["mission", id] } });
  const { data: status, refetch: refetchStatus } = useGetMissionStatus(id, { query: { enabled: !!id, refetchInterval: 5000, queryKey: ["mission-status", id] } });

  const queenApprove = useQueenApprove();
  const queenVeto = useQueenVeto();
  const queenIntervene = useQueenIntervene();
  const killMission = useKillMission();

  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [objectiveCopied, setObjectiveCopied] = useState(false);
  // Live mission spend — driven by cost_tick SSE events during a debate, falls
  // back to mission.costUsd from the API on cold load. costFlash briefly tints
  // the header readout chart-2 each time a new tick arrives, so the operator
  // can see money moving without staring at the digits.
  const [liveCost, setLiveCost] = useState<number | null>(null);
  const [lastTickBreakdown, setLastTickBreakdown] = useState<{
    agent: string;
    cycle: number;
    tokensIn: number;
    tokensOut: number;
    reasoningTokens: number;
    callCostUsd: number;
  } | null>(null);
  const [costFlash, setCostFlash] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reset live cost state when navigating between missions so a stale tick
  // total from mission A doesn't briefly mask mission B's API value.
  useEffect(() => {
    setLiveCost(null);
    setLastTickBreakdown(null);
    setCostFlash(false);
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
  }, [id]);
  type CycleSourceKey = string;
  const [liveBuckets, setLiveBuckets] = useState<Map<CycleSourceKey, ChartAnnotations>>(new Map());
  const [clearedThroughCycle, setClearedThroughCycle] = useState<number>(-1);
  const chartHandleRef = useRef<MarketChartHandle | null>(null);
  // Fullscreen mode for the chart widget. When true, the same MarketChart
  // instance moves out of the draggable widget and into a fixed full-viewport
  // overlay so the operator can read AI-drawn levels at scale. The chart
  // unmounts/remounts on toggle, but useChartAnnotations re-applies all
  // mergedAnnotations to the new chart instance because resetKey changes.
  const [chartFullscreen, setChartFullscreen] = useState(false);
  const targetSymbol = mission?.targetSymbol ?? null;
  const [chartInterval, setChartInterval] = useState<string>("5m");
  const [liveMarkPrice, setLiveMarkPrice] = useState<number | null>(null);
  const [liveMarkTs, setLiveMarkTs] = useState<number | null>(null);

  useEffect(() => {
    if (!targetSymbol) return;
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    const url = `${base}/api/market/${encodeURIComponent(targetSymbol)}/stream`;
    const es = new EventSource(url);
    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as { symbol?: string; markPrice?: number };
        if (data.symbol && data.symbol.toUpperCase() !== targetSymbol.toUpperCase()) return;
        if (typeof data.markPrice === "number" && Number.isFinite(data.markPrice)) {
          setLiveMarkPrice(data.markPrice);
          setLiveMarkTs(Date.now());
        }
      } catch {
        /* ignore parse errors */
      }
    };
    return () => { es.close(); };
  }, [targetSymbol]);

  const [vetoReason, setVetoReason] = useState("");
  const [selectedPacketId, setSelectedPacketId] = useState<number | null>(null);
  const [refinement, setRefinement] = useState("");
  const feedScrollRef = useRef<HTMLDivElement>(null);

  // Workspace size measurement (drives default layout calculation).
  // Use a callback ref so we re-measure when the workspace div mounts —
  // the early returns for loading/missing-mission mean the ref attaches
  // on a later render, not the initial one.
  const [workspaceSize, setWorkspaceSize] = useState({ w: 0, h: 0 });
  const roRef = useRef<ResizeObserver | null>(null);
  const workspaceRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    const measure = () => setWorkspaceSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
  }, []);

  const { layout, updateBox, bringToFront, reset: resetLayout } =
    useWorkspaceLayout(id, workspaceSize.w, workspaceSize.h);

  const currentStatusEarly = status?.status || mission?.status;
  const isRunning = currentStatusEarly === "running" || currentStatusEarly === "executing" || isStreaming;

  const { data: packets, refetch: refetchPackets } = useGetMissionReasoningPackets(id, {
    query: {
      enabled: !!id,
      refetchInterval: isRunning ? 2000 : false,
      queryKey: ["mission-packets", id],
    }
  });

  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = mission?.status as string | undefined;
    if (prev && prev !== curr && (curr === "completed" || curr === "aborted" || curr === "vetoed")) {
      refetchPackets();
      const t = setTimeout(() => refetchPackets(), 1500);
      return () => clearTimeout(t);
    }
    prevStatusRef.current = curr;
    return undefined;
  }, [mission?.status, refetchPackets]);

  const sortedPackets = (packets ?? []).slice().sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const getPacketMeta = (p: typeof sortedPackets[number]) => {
    if (p.agentRole === "worker") {
      if (p.reasoning?.startsWith("Strategist")) return { agentName: "STRATEGIST", stage: "open" as const };
      if (p.reasoning?.startsWith("Adversary")) return { agentName: "ADVERSARY", stage: "critique" as const };
      if (p.reasoning?.startsWith("Synthesizer")) return { agentName: "SYNTHESIZER", stage: "synthesis" as const };
    }
    return { agentName: p.agentRole.toUpperCase(), stage: "" as const };
  };

  const transientEvents = events.filter(e =>
    ["queen_checkpoint", "queen_guidance", "deadlock", "error"].includes(e.type)
  );

  // Detect a Queen FINAL VERDICT packet — the engine writes verdict =
  // "FINAL_VERDICT" with the stance (CONFIRM | COUNTER | STAND_DOWN) carried
  // inside the structured markdown proposal on a `Stance:` line. When present
  // in awaiting_queen, the Queen Console swaps to the decisive verdict UI
  // (stance + trade plan + LOCK / STAND DOWN).
  const finalVerdict = (() => {
    if (!packets) return null;
    const queenPackets = packets
      .filter(p => p.agentRole === "queen" && p.verdict === "FINAL_VERDICT")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const fv = queenPackets[0];
    if (!fv) return null;
    const proposal = fv.proposal ?? "";
    const grab = (label: string) => {
      const re = new RegExp(`-\\s*${label}:\\s*([^\\n]+)`, "i");
      return proposal.match(re)?.[1]?.trim() ?? "—";
    };
    const stanceRaw = grab("Stance").toUpperCase();
    const stance: "CONFIRM" | "COUNTER" | "STAND_DOWN" =
      stanceRaw === "CONFIRM" ? "CONFIRM"
      : stanceRaw === "COUNTER" ? "COUNTER"
      : "STAND_DOWN";
    const headline = grab("Headline");
    const symbol = grab("Symbol").toUpperCase();
    const bias = grab("Bias").toUpperCase();
    const rationale = (proposal.split(/===\s*QUEEN RATIONALE\s*===/i)[1] ?? "").trim();
    const tradePlan = {
      symbol,
      bias,
      entry: grab("Entry"),
      stop: grab("Stop"),
      tp1: grab("TP1"),
      tp2: grab("TP2"),
      sizing: grab("Sizing"),
      rr: grab("R:R"),
    };
    // Adaptive-timing fields written by queenFinalVerdict. Older verdicts
    // produced before Task #35 don't carry these lines, so the parser falls
    // back to "—" / "(none)" gracefully and the UI just hides those rows.
    const selectedTimeframe = grab("Timeframe");
    const promotionReasonRaw = grab("PromotionReason");
    const reanchorReasonRaw = grab("ReanchorReason");
    const cleanReason = (s: string) => {
      const trimmed = s.trim();
      if (!trimmed || trimmed === "—" || trimmed === "(none)") return "";
      return trimmed;
    };
    return {
      packetId: fv.id,
      cycle: fv.cycle,
      stance,
      headline,
      rationale,
      tradePlan,
      raw: proposal,
      selectedTimeframe: selectedTimeframe === "—" ? "" : selectedTimeframe,
      promotionReason: cleanReason(promotionReasonRaw),
      reanchorReason: cleanReason(reanchorReasonRaw),
    };
  })();

  const debateOptions = (() => {
    if (!packets) return [] as Array<{ id: number; cycle: number; proposal: string; symbol: string; bias: string; rationale: string; score: number; verdict: string; observerNote: string }>;
    const synthesizers = packets.filter(p => p.agentRole === "worker" && p.reasoning?.startsWith("Synthesizer"));
    const observers = packets.filter(p => p.agentRole === "observer");
    // Pull Symbol/Bias out of the raw thesis block so the anchor cards can
    // show a "BTC · SHORT" badge + a single-sentence rationale instead of
    // dumping the full TRADE THESIS markdown into a 4-line preview.
    const parseThesis = (raw: string) => {
      const symMatch = raw.match(/Symbol:\s*([A-Z0-9]+)/i);
      const biasMatch = raw.match(/Bias:\s*([A-Za-z]+)(?:\s*[—\-:]\s*([^\n]*))?/i);
      return {
        symbol: (symMatch?.[1] ?? "—").toUpperCase(),
        bias: (biasMatch?.[1] ?? "—").toUpperCase(),
        // First sentence (or 140 chars) of the bias rationale — gives the
        // operator the thesis's edge in one glance, no scrolling required.
        rationale: (biasMatch?.[2] ?? "").trim().split(/(?<=[.!?])\s/)[0]?.slice(0, 160) ?? "",
      };
    };
    return synthesizers
      .map(s => {
        const obs = observers.find(o => o.cycle === s.cycle);
        const proposal = s.proposal || "";
        const parsed = parseThesis(proposal);
        return {
          id: s.id,
          cycle: s.cycle,
          proposal,
          symbol: parsed.symbol,
          bias: parsed.bias,
          rationale: parsed.rationale,
          score: obs?.alignmentScore ?? 0,
          verdict: obs?.verdict ?? "—",
          observerNote: obs?.reasoning?.substring(0, 280) ?? "",
        };
      })
      .sort((a, b) => b.score - a.score);
  })();

  useEffect(() => {
    if (feedScrollRef.current) {
      feedScrollRef.current.scrollTop = feedScrollRef.current.scrollHeight;
    }
  }, [sortedPackets.length, transientEvents.length]);

  const mergedAnnotations = useMemo<ChartAnnotations>(() => {
    type Pkt = { id?: number; cycle?: number; agentRole?: string; annotations?: ChartAnnotations | null };
    const buckets = new Map<string, ChartAnnotations>();
    for (const p of sortedPackets as Pkt[]) {
      const a = p.annotations;
      if (!a || !(a.markers?.length || a.priceLines?.length)) continue;
      const cycle = Number(p.cycle ?? 0);
      const role = String(p.agentRole ?? "");
      const source = role === "queen" ? "queen" : "synthesizer";
      buckets.set(`${cycle}:${source}`, a);
    }
    for (const [k, v] of liveBuckets) buckets.set(k, v);

    if (buckets.size === 0) return { markers: [], priceLines: [] };

    const cycles = Array.from(buckets.keys()).map((k) => Number(k.split(":")[0]));
    const maxCycle = Math.max(...cycles);
    if (maxCycle <= clearedThroughCycle) return { markers: [], priceLines: [] };

    const out: ChartAnnotations = { markers: [], priceLines: [] };
    for (const [k, v] of buckets) {
      if (Number(k.split(":")[0]) !== maxCycle) continue;
      out.markers.push(...(v.markers ?? []));
      out.priceLines.push(...(v.priceLines ?? []));
    }
    return out;
  }, [sortedPackets, liveBuckets, clearedThroughCycle]);

  const annHook = useChartAnnotations(
    chartHandleRef,
    mergedAnnotations,
    // Reset on symbol, interval, OR fullscreen toggle. Fullscreen now portals
    // the chart to document.body to escape the react-rnd transform context
    // (CSS `position: fixed` resolves relative to the nearest transformed
    // ancestor, which is the Rnd widget — that's why an inline `fixed inset-0`
    // overlay only filled the widget bounds, not the viewport). Portaling
    // remounts the chart, so we must rebuild markers/lines on toggle.
    `${targetSymbol ?? "none"}|${chartInterval}|${chartFullscreen ? "fs" : "win"}`,
  );

  // Native Fullscreen API ref — when entering fullscreen we request the
  // browser's OS-level fullscreen on this element so it covers the entire
  // monitor (escaping the Replit workspace iframe). A pure DOM portal to
  // document.body only covers the iframe viewport, not the screen.
  const fullscreenOverlayRef = useRef<HTMLDivElement | null>(null);

  // When chartFullscreen flips to true, request native fullscreen on the
  // overlay element. When the user exits via Esc or the OS fullscreen UI,
  // browsers fire `fullscreenchange` — sync React state in response so our
  // overlay unmounts cleanly.
  useEffect(() => {
    if (!chartFullscreen) return;
    const el = fullscreenOverlayRef.current;
    if (!el) return;
    // Some browsers expose vendor-prefixed variants; prefer the standard.
    type FSElement = HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    };
    const fsEl = el as FSElement;
    const req = fsEl.requestFullscreen?.bind(fsEl) ?? fsEl.webkitRequestFullscreen?.bind(fsEl);
    if (req) {
      // Promise rejects if user gesture context is lost or iframe lacks
      // `allowfullscreen` — silently fall back to viewport-only overlay.
      Promise.resolve(req()).catch(() => undefined);
    }
    const onChange = () => {
      if (!document.fullscreenElement) setChartFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, [chartFullscreen]);

  // Allow Escape to exit fullscreen — standard "video player" muscle memory.
  // The native Fullscreen API also handles Esc, but this catches the
  // fallback case where requestFullscreen was rejected.
  useEffect(() => {
    if (!chartFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.fullscreenElement) {
          type FSDoc = Document & { webkitExitFullscreen?: () => Promise<void> };
          const d = document as FSDoc;
          const exit = d.exitFullscreen?.bind(d) ?? d.webkitExitFullscreen?.bind(d);
          if (exit) Promise.resolve(exit()).catch(() => undefined);
        }
        setChartFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chartFullscreen]);

  // When the user clicks our in-overlay exit button, we also need to leave
  // native fullscreen first.
  const exitChartFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      type FSDoc = Document & { webkitExitFullscreen?: () => Promise<void> };
      const d = document as FSDoc;
      const exit = d.exitFullscreen?.bind(d) ?? d.webkitExitFullscreen?.bind(d);
      if (exit) Promise.resolve(exit()).catch(() => undefined);
    }
    setChartFullscreen(false);
  }, []);

  const handleRun = async () => {
    if (!id) return;
    setIsStreaming(true);
    setEvents([]);

    try {
      const response = await fetch(`/api/missions/${id}/run`, { method: "POST" });
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              setEvents(prev => [...prev, data]);

              if (data.type === "cost_tick") {
                const total = Number(data.data?.missionTotalCostUsd ?? 0);
                if (Number.isFinite(total)) setLiveCost(total);
                setLastTickBreakdown({
                  agent: String(data.data?.agent ?? "?"),
                  cycle: Number(data.data?.cycle ?? 0),
                  tokensIn: Number(data.data?.tokensIn ?? 0),
                  tokensOut: Number(data.data?.tokensOut ?? 0),
                  reasoningTokens: Number(data.data?.reasoningTokens ?? 0),
                  callCostUsd: Number(data.data?.callCostUsd ?? 0),
                });
                setCostFlash(true);
                if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
                flashTimerRef.current = setTimeout(() => setCostFlash(false), 600);
              }

              if (data.type === "chart_annotation" && data.data?.annotations) {
                const cycle = Number(data.data.cycle ?? 0);
                const source = String(data.data.source ?? "synthesizer");
                const ann = data.data.annotations as ChartAnnotations;
                setLiveBuckets((prev) => {
                  const next = new Map(prev);
                  next.set(`${cycle}:${source}`, ann);
                  return next;
                });
              }

              if (['done', 'error', 'queen_checkpoint', 'deadlock'].includes(data.type)) {
                refetchStatus();
                refetchMission();
              }
            } catch (e) {
              console.error("Failed to parse SSE event", e);
            }
          }
        }
      }
    } catch (error) {
      console.error("Stream failed", error);
    } finally {
      setIsStreaming(false);
      refetchStatus();
      refetchMission();
    }
  };

  // Banner shown after LOCK THESIS so the operator knows whether the server
  // also auto-fired the trade (paper mode) or whether they still owe a manual
  // EXECUTE TRADE NOW click (real mode). Cleared on unmount / next click.
  const [approveOutcome, setApproveOutcome] = useState<
    { autoExecuteScheduled: boolean; executionMode: "paper" | "real" | null } | null
  >(null);

  const handleApprove = () => {
    if (!id || !mission?.thesisLock) return;
    setApproveOutcome(null);
    queenApprove.mutate(
      { id, data: { reason: "Approved by manual oversight", thesisLock: mission.thesisLock } },
      {
        onSuccess: (data) => {
          const d = data as { autoExecuteScheduled?: boolean; executionMode?: "paper" | "real" | null };
          setApproveOutcome({
            autoExecuteScheduled: !!d?.autoExecuteScheduled,
            executionMode: d?.executionMode ?? null,
          });
          refetchStatus();
          refetchMission();
          refetchPackets();
          // Give the background executeMission a moment, then refresh the
          // exec snapshot so the new orders/position appear without waiting
          // for the 4s poll.
          setTimeout(() => { refetchExec(); refetchPackets(); }, 1500);
        },
      }
    );
  };

  // Task #36: LOCK & EXECUTE submits the Queen's final trade plan to
  // Hyperliquid (or paper-simulates it). The legacy queenApprove path is kept
  // for the older "thesis lock only" awaiting_queen state — only the verdict
  // path with a structured trade plan calls /execute. Errors (no wallet,
  // STAND_DOWN, risk-cap exceeded, etc.) are surfaced inline.
  const executeMission = useExecuteMission();
  const killExecution = useKillMissionExecution();
  const { data: execSnapshot, refetch: refetchExec } = useGetMissionExecution(
    id ?? 0,
    { query: { enabled: !!id, refetchInterval: 4000, queryKey: ["mission-execution", id] } },
  );
  const [execError, setExecError] = useState<string | null>(null);

  const handleLockExecute = async () => {
    if (!id) return;
    setExecError(null);
    try {
      await executeMission.mutateAsync({ id });
      refetchStatus(); refetchMission(); refetchPackets(); refetchExec();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setExecError(e?.response?.data?.error ?? e?.message ?? "Execution failed");
    }
  };

  const handleKillExecution = async () => {
    if (!id) return;
    if (!window.confirm("KILL: cancel all resting orders and flat-close any open position. Continue?")) return;
    setExecError(null);
    try {
      await killExecution.mutateAsync({ id });
      refetchStatus(); refetchMission(); refetchPackets(); refetchExec();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setExecError(e?.response?.data?.error ?? e?.message ?? "Kill failed");
    }
  };

  const handleVeto = () => {
    if (!id || !vetoReason) return;
    queenVeto.mutate(
      { id, data: { reason: vetoReason } },
      { onSuccess: () => { refetchStatus(); refetchMission(); } }
    );
  };

  const handleKill = () => {
    if (!id) return;
    if (!window.confirm("Kill this mission? The current debate will stop after the next agent step.")) return;
    killMission.mutate(
      { id },
      {
        onSuccess: () => {
          setIsStreaming(false);
          refetchStatus();
          refetchMission();
          refetchPackets();
        }
      }
    );
  };

  const handleIntervene = () => {
    if (!id || !selectedPacketId) return;
    const chosen = debateOptions.find(o => o.id === selectedPacketId);
    if (!chosen) return;

    const guidance = `ANCHOR DIRECTION (selected by Queen from cycle ${chosen.cycle}, observer score ${chosen.score.toFixed(2)}):
"${chosen.proposal}"

Observer noted on this direction: ${chosen.observerNote}

${refinement ? `ADDITIONAL QUEEN REFINEMENT: ${refinement}\n\n` : ""}Workers: build your next debate around this anchor. Push it past 0.85 by addressing the observer's gaps with specifics, scope, and rigor.`;

    queenIntervene.mutate(
      { id, data: { guidance } },
      {
        onSuccess: () => {
          setSelectedPacketId(null);
          setRefinement("");
          refetchStatus();
          refetchMission();
          refetchPackets();
        }
      }
    );
  };

  if (missionLoading) {
    return (
      <Layout>
        <div className="p-6"><Skeleton className="h-64 w-full bg-secondary" /></div>
      </Layout>
    );
  }

  if (!mission) return <Layout><div className="p-6 text-destructive font-mono">MISSION NOT FOUND</div></Layout>;

  const currentStatus = status?.status || mission.status;
  const canRun = currentStatus === "pending";
  const needsQueenApproval = currentStatus === "awaiting_queen";
  const needsIntervention = currentStatus === "awaiting_intervention";
  const canKill = ["running", "executing", "awaiting_queen", "awaiting_intervention"].includes(currentStatus) || isStreaming;

  return (
    <Layout>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header Panel */}
        <header className="border-b border-border bg-card shrink-0 p-4 md:p-6 flex flex-col md:flex-row gap-4 md:gap-6 justify-between items-start md:items-center relative z-30 shadow-md">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-3xl font-mono font-bold text-primary tracking-widest uppercase">MSN-{id.toString().padStart(3, '0')}</h1>
              <StatusBadge status={currentStatus as any} />
              <span className="font-mono text-xs px-2 py-1 bg-secondary rounded-sm text-muted-foreground border border-border">CYCLES: {status?.cycleCount || mission.cycleCount}</span>
              <span
                className={`font-mono text-xs px-2 py-1 rounded-sm border transition-colors duration-500 cursor-help ${
                  costFlash
                    ? "bg-chart-2/20 text-chart-2 border-chart-2/60 shadow-[0_0_10px_hsl(var(--chart-2)/0.4)]"
                    : "bg-secondary text-muted-foreground border-border"
                }`}
                data-testid="mission-cost-ticker"
                title={
                  lastTickBreakdown
                    ? `Total LLM spend: ${fmtUsd(liveCost ?? mission.costUsd ?? 0)}\nLast tick — ${lastTickBreakdown.agent} (cycle ${lastTickBreakdown.cycle}):\n  in:  ${lastTickBreakdown.tokensIn} tok\n  out: ${lastTickBreakdown.tokensOut} tok (${lastTickBreakdown.reasoningTokens} reasoning)\n  cost: ${fmtUsd(lastTickBreakdown.callCostUsd)}\n\ngpt-5-mini · $0.25/M in · $2/M out`
                    : `Cumulative LLM spend on this mission.\ngpt-5-mini · $0.25/M in · $2/M out (reasoning billed as out)`
                }
              >
                COST: {fmtUsd(liveCost ?? mission.costUsd ?? 0)}
              </span>
            </div>
            <div className="flex items-center gap-2 max-w-3xl">
              <p className="font-mono text-sm text-foreground/90 truncate min-w-0" title={mission.primeObjective}>
                <span className="text-muted-foreground mr-2">OBJ:</span>{mission.primeObjective}
              </p>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(mission.primeObjective);
                    setObjectiveCopied(true);
                    setTimeout(() => setObjectiveCopied(false), 1500);
                  } catch {
                    /* clipboard unavailable — silently no-op */
                  }
                }}
                className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-sm border border-border text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors"
                aria-label="Copy objective to clipboard"
                title={objectiveCopied ? "Copied" : "Copy objective"}
                data-testid="btn-copy-objective"
              >
                {objectiveCopied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          <div className="flex shrink-0 gap-2 flex-wrap">
            <Button
              onClick={resetLayout}
              variant="outline"
              className="font-mono font-bold rounded-sm h-12 px-4 border-border text-muted-foreground hover:text-primary"
              data-testid="btn-reset-layout"
              title="Reset widget layout to defaults"
            >
              <LayoutGrid className="w-4 h-4 mr-2" />
              RESET LAYOUT
            </Button>
            {canRun && (
              <Button
                onClick={handleRun}
                disabled={isStreaming}
                className="font-mono font-bold rounded-sm h-12 px-6 shadow-[0_0_15px_hsl(var(--primary)/0.2)]"
                data-testid="btn-run-mission"
              >
                {isStreaming ? (
                  <><Activity className="w-4 h-4 mr-2 animate-spin" /> WORKERS DEBATING...</>
                ) : (
                  <><Play className="w-4 h-4 mr-2" /> INITIATE DEBATE</>
                )}
              </Button>
            )}
            {canKill && (
              <Button
                onClick={handleKill}
                disabled={killMission.isPending}
                variant="destructive"
                className="font-mono font-bold rounded-sm h-12 px-6"
                data-testid="btn-kill-mission"
                title="Abort the running mission"
              >
                <Square className="w-4 h-4 mr-2 fill-current" />
                {killMission.isPending ? "KILLING..." : "KILL"}
              </Button>
            )}
          </div>
        </header>

        {/* Workspace */}
        <div
          ref={workspaceRef}
          className="flex-1 relative overflow-hidden bg-[url('https://transparenttextures.com/patterns/cubes.png')] bg-repeat bg-[length:20px]"
          data-testid="mission-workspace"
        >
          <div className="absolute inset-0 bg-background/95 z-0 pointer-events-none" />

          {layout && (
            <>
              {/* CHART WIDGET — When windowed, MarketChart renders inside the
                  widget body. When fullscreen, the overlay (with its own
                  MarketChart instance) is portaled to document.body. The
                  portal is required because react-rnd uses CSS `transform`
                  for positioning, and CSS `position: fixed` resolves relative
                  to the nearest transformed ancestor — so an inline
                  `fixed inset-0` div would only fill the widget bounds, not
                  the viewport. The chart remounts on toggle; disposed-canvas
                  errors are swallowed by the capture-phase filter in
                  src/main.tsx, and useChartAnnotations re-applies all markers
                  and price lines because resetKey now includes the fullscreen
                  flag. */}
              <MissionWidget
                title={targetSymbol ? `${targetSymbol}-PERP · LIVE CHART` : "CHART (no symbol)"}
                accentColor="primary"
                box={layout.chart}
                minWidth={420}
                minHeight={280}
                onChange={(b) => updateBox("chart", b)}
                onFocus={() => bringToFront("chart")}
                testId="widget-chart"
                headerExtra={
                  targetSymbol && !chartFullscreen && (
                    <ChartControls
                      chartInterval={chartInterval}
                      setChartInterval={setChartInterval}
                      markerCount={annHook.markerCount}
                      priceLineCount={annHook.priceLineCount}
                      onClear={() => {
                        annHook.clear();
                        setLiveBuckets(new Map());
                        const maxCycle = sortedPackets.reduce(
                          (m, p) => Math.max(m, Number((p as { cycle?: number }).cycle ?? -1)),
                          -1,
                        );
                        setClearedThroughCycle(maxCycle);
                      }}
                      onToggleFullscreen={() => setChartFullscreen((v) => !v)}
                      isFullscreen={chartFullscreen}
                    />
                  )
                }
              >
                <div className="w-full h-full p-2">
                  {!targetSymbol ? (
                    <div className="w-full h-full flex items-center justify-center text-muted-foreground font-mono text-xs tracking-widest">
                      NO TARGET SYMBOL · CREATE A NEW MISSION WITH A SYMBOL
                    </div>
                  ) : (
                    <>
                      {/* Placeholder shown inside the widget while the chart
                          is visually promoted to fullscreen. */}
                      {chartFullscreen && (
                        <button
                          type="button"
                          onClick={exitChartFullscreen}
                          className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground hover:text-primary font-mono text-xs tracking-widest border border-dashed border-border rounded-sm transition-colors"
                          data-testid="btn-exit-fullscreen-placeholder"
                        >
                          <Minimize2 className="w-5 h-5" />
                          CHART OPEN IN FULLSCREEN · CLICK TO RETURN
                        </button>
                      )}
                      {/* Chart: render inline when windowed, portal to body
                          when fullscreen. The portal escapes react-rnd's
                          CSS transform so `position: fixed` actually means
                          "viewport", not "widget bounds". */}
                      {!chartFullscreen ? (
                        <div className="w-full h-full" data-testid="chart-windowed">
                          <MarketChart
                            ref={chartHandleRef}
                            symbol={targetSymbol}
                            interval={chartInterval}
                            latestPrice={liveMarkPrice}
                            latestTimestamp={liveMarkTs}
                          />
                        </div>
                      ) : (
                        createPortal(
                          <div
                            ref={fullscreenOverlayRef}
                            className="fixed inset-0 z-[1000] bg-background flex flex-col"
                            data-testid="chart-fullscreen-overlay"
                          >
                            <div className="flex items-center justify-between gap-4 px-4 py-2 border-b border-primary/40 bg-card shadow-md shrink-0">
                              <div className="flex items-center gap-3 min-w-0">
                                <h2 className="font-mono text-sm font-bold text-primary tracking-widest uppercase truncate">
                                  {targetSymbol}-PERP · LIVE CHART · FULLSCREEN
                                </h2>
                                <span className="font-mono text-[10px] tracking-widest text-muted-foreground hidden md:inline">
                                  MSN-{id.toString().padStart(3, "0")}
                                </span>
                              </div>
                              <ChartControls
                                chartInterval={chartInterval}
                                setChartInterval={setChartInterval}
                                markerCount={annHook.markerCount}
                                priceLineCount={annHook.priceLineCount}
                                onClear={() => {
                                  annHook.clear();
                                  setLiveBuckets(new Map());
                                  const maxCycle = sortedPackets.reduce(
                                    (m, p) => Math.max(m, Number((p as { cycle?: number }).cycle ?? -1)),
                                    -1,
                                  );
                                  setClearedThroughCycle(maxCycle);
                                }}
                                onToggleFullscreen={exitChartFullscreen}
                                isFullscreen
                              />
                            </div>
                            <div className="flex-1 p-3 min-h-0">
                              <MarketChart
                                ref={chartHandleRef}
                                symbol={targetSymbol}
                                interval={chartInterval}
                                latestPrice={liveMarkPrice}
                                latestTimestamp={liveMarkTs}
                              />
                            </div>
                            <div className="px-4 py-1 border-t border-border bg-card text-center font-mono text-[10px] tracking-widest text-muted-foreground shrink-0">
                              PRESS <kbd className="px-1 py-0.5 border border-border rounded-sm text-foreground/80">ESC</kbd> TO RETURN TO TERMINAL
                            </div>
                          </div>,
                          document.body,
                        )
                      )}
                    </>
                  )}
                </div>
              </MissionWidget>

              {/* FEED WIDGET */}
              <MissionWidget
                title="REASONING FEED"
                accentColor="chart-2"
                box={layout.feed}
                minWidth={320}
                minHeight={240}
                onChange={(b) => updateBox("feed", b)}
                onFocus={() => bringToFront("feed")}
                testId="widget-feed"
                headerExtra={
                  <span className="font-mono text-[10px] tracking-widest text-muted-foreground">
                    {sortedPackets.length} PACKETS
                  </span>
                }
              >
                <div ref={feedScrollRef} className="absolute inset-0 overflow-y-auto p-3 space-y-3" data-testid="feed-scroll">
                  {sortedPackets.length === 0 && !isRunning && currentStatus === "pending" && (
                    <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-muted-foreground font-mono opacity-50">
                      <Shield className="w-12 h-12 mb-3 text-primary opacity-50" />
                      <p className="text-xs tracking-widest">SYSTEM READY · AWAITING DEBATE</p>
                    </div>
                  )}

                  {sortedPackets.length === 0 && isRunning && (
                    <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-chart-4 font-mono">
                      <Activity className="w-10 h-10 mb-3 animate-spin" />
                      <p className="text-xs tracking-widest">STRATEGIST IS THINKING…</p>
                      <p className="text-[10px] text-muted-foreground mt-1">~30-60s for first proposal</p>
                    </div>
                  )}

                  {sortedPackets.map((p) => {
                    const meta = getPacketMeta(p);

                    if (p.agentRole === "worker") {
                      const agentMeta = AGENT_META[meta.agentName] || AGENT_META.STRATEGIST;
                      const Icon = agentMeta.icon;
                      return (
                        <div key={p.id} className="w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
                          <Card className={`bg-card/80 backdrop-blur-sm border-${agentMeta.color}/30 rounded-sm overflow-hidden`}>
                            <div className={`bg-${agentMeta.color}/10 px-3 py-1.5 border-b border-border flex justify-between items-center`}>
                              <div className="flex items-center gap-2">
                                <Icon className={`w-3 h-3 text-${agentMeta.color}`} />
                                <span className={`font-mono text-[10px] font-bold text-${agentMeta.color} tracking-widest uppercase`}>WORKER · {agentMeta.label}</span>
                              </div>
                              <span className="font-mono text-[10px] text-muted-foreground">CYCLE {p.cycle}</span>
                            </div>
                            <div className="p-3 font-mono text-xs">
                              <div className="text-foreground/90 whitespace-pre-wrap">{p.proposal || <span className="text-muted-foreground italic">(empty response)</span>}</div>
                              <PacketTokensLine packet={p} />
                            </div>
                          </Card>
                        </div>
                      );
                    }

                    if (p.agentRole === "observer") {
                      return (
                        <div key={p.id} className="w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
                          <Card className="bg-card/90 backdrop-blur-sm border-chart-2/40 rounded-sm overflow-hidden">
                            <div className="bg-chart-2/10 px-3 py-1.5 border-b border-border flex justify-between items-center gap-2">
                              <span className="font-mono text-[10px] font-bold text-chart-2 tracking-widest uppercase truncate">OBSERVER · CYCLE {p.cycle}</span>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="font-mono text-[10px] text-muted-foreground">{p.alignmentScore?.toFixed(2) ?? "—"}</span>
                                <span className={`font-mono text-[10px] font-bold px-1.5 py-0.5 rounded-sm ${
                                  p.verdict === 'PASS' ? 'bg-chart-2 text-chart-2-foreground' :
                                  p.verdict === 'ESCALATE' ? 'bg-chart-5 text-chart-5-foreground' :
                                  'bg-destructive text-destructive-foreground'
                                }`}>
                                  {p.verdict ?? "—"}
                                </span>
                              </div>
                            </div>
                            <div className="p-3 font-mono text-xs">
                              <div className="text-foreground/80 whitespace-pre-wrap">{p.reasoning}</div>
                              <PacketTokensLine packet={p} />
                            </div>
                          </Card>
                        </div>
                      );
                    }

                    if ((p.agentRole as string) === "executor") {
                      return (
                        <div key={p.id} className="w-full animate-in fade-in slide-in-from-bottom-4 duration-700">
                          <Card className="bg-primary/5 border-primary/50 rounded-sm overflow-hidden shadow-[0_0_24px_hsl(var(--primary)/0.2)]">
                            <div className="bg-primary/15 px-3 py-1.5 border-b border-primary/40 flex items-center gap-2">
                              <Shield className="w-4 h-4 text-primary" />
                              <span className="font-mono text-[11px] font-bold text-primary tracking-widest uppercase">
                                EXECUTOR · FINAL DELIVERABLE
                              </span>
                            </div>
                            <div className="p-4 font-mono text-xs text-foreground/95 whitespace-pre-wrap leading-relaxed">
                              {p.proposal || <span className="text-destructive">Executor failed: {p.reasoning}</span>}
                              <PacketTokensLine packet={p} />
                            </div>
                          </Card>
                        </div>
                      );
                    }

                    if (p.agentRole === "queen") {
                      const isIntervention = p.verdict === "INTERVENTION";
                      return (
                        <div key={p.id} className="w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
                          <Card className={`${isIntervention ? "bg-chart-3/5 border-chart-3/40" : "bg-chart-5/5 border-chart-5/40"} rounded-sm overflow-hidden`}>
                            <div className={`${isIntervention ? "bg-chart-3/10 border-chart-3/30" : "bg-chart-5/10 border-chart-5/30"} px-3 py-1.5 border-b flex items-center gap-2`}>
                              <Crown className={`w-3.5 h-3.5 ${isIntervention ? "text-chart-3" : "text-chart-5"}`} />
                              <span className={`font-mono text-[10px] font-bold ${isIntervention ? "text-chart-3" : "text-chart-5"} tracking-widest uppercase`}>
                                QUEEN · {isIntervention ? "INTERVENTION" : "THESIS LOCK"}
                              </span>
                            </div>
                            <div className="p-3 font-mono text-xs text-foreground/90 whitespace-pre-wrap">
                              {p.proposal || p.reasoning}
                              <PacketTokensLine packet={p} />
                            </div>
                          </Card>
                        </div>
                      );
                    }

                    return null;
                  })}

                  {isRunning && sortedPackets.length > 0 && (
                    <div className="w-full py-2 animate-pulse">
                      <div className="flex items-center justify-center gap-2 text-chart-4 font-mono text-[10px] tracking-widest">
                        <Activity className="w-3 h-3 animate-spin" />
                        <span>NEXT AGENT THINKING…</span>
                      </div>
                    </div>
                  )}

                  {transientEvents.map((evt, i) => (
                    <div key={`evt-${i}`} className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                      {evt.type === "queen_checkpoint" && (
                        <div className="text-center font-mono font-bold text-chart-5 text-[10px] tracking-[0.2em] my-3">
                          ━━━ QUEEN REVIEW REQUIRED ━━━
                        </div>
                      )}
                      {evt.type === "deadlock" && (
                        <Card className="bg-chart-3/5 border-chart-3/40 rounded-sm">
                          <div className="p-3 text-center">
                            <ShieldAlert className="w-5 h-5 text-chart-3 mx-auto mb-1 animate-pulse" />
                            <div className="font-mono font-bold text-chart-3 text-[10px] tracking-widest uppercase mb-1">WORKER DEADLOCK</div>
                            <div className="font-mono text-[10px] text-foreground/80">{evt.data.message}</div>
                          </div>
                        </Card>
                      )}
                      {evt.type === "error" && (
                        <div className="p-3 bg-destructive/10 border border-destructive text-destructive font-mono text-xs rounded-sm">
                          ERR: {evt.data.message}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </MissionWidget>

              {/* QUEEN CONSOLE WIDGET */}
              <MissionWidget
                title={
                  needsQueenApproval && finalVerdict
                    ? `QUEEN · FINAL VERDICT (${finalVerdict.stance})`
                    : needsIntervention
                    ? "QUEEN · CHOOSE DEBATE ANCHOR"
                    : needsQueenApproval
                    ? "QUEEN · FINAL APPROVAL"
                    : "QUEEN CONSOLE"
                }
                accentColor={needsIntervention ? "chart-3" : "chart-5"}
                box={layout.queen}
                minWidth={420}
                minHeight={180}
                onChange={(b) => updateBox("queen", b)}
                onFocus={() => bringToFront("queen")}
                testId="widget-queen"
              >
                <div className="absolute inset-0 overflow-y-auto p-4">
                  {/* Post-approve banner: tells the operator whether the
                      server auto-fired the trade (paper) or whether they
                      still owe a manual EXECUTE TRADE NOW click (real). */}
                  {approveOutcome && (
                    <div
                      className={`mb-3 px-3 py-2 rounded-sm border font-mono text-[11px] leading-relaxed ${
                        approveOutcome.autoExecuteScheduled
                          ? "bg-chart-2/10 border-chart-2/40 text-chart-2"
                          : approveOutcome.executionMode === "real"
                          ? "bg-chart-4/10 border-chart-4/40 text-chart-4"
                          : "bg-secondary/40 border-border text-muted-foreground"
                      }`}
                      data-testid="approve-outcome-banner"
                    >
                      {approveOutcome.autoExecuteScheduled ? (
                        <>THESIS LOCKED · PAPER MODE — bracket auto-submitted in background. Watch EXECUTION panel.</>
                      ) : approveOutcome.executionMode === "real" ? (
                        <>THESIS LOCKED · REAL MODE — trade NOT placed. Press EXECUTE TRADE NOW to fire on Hyperliquid.</>
                      ) : (
                        <>THESIS LOCKED — no structured trade plan to execute. Deliverable LLM is running.</>
                      )}
                    </div>
                  )}
                  {/* Post-approval, pre-execution console: the FINAL_VERDICT
                      packet still parses, mission has moved past
                      awaiting_queen, and no executor orders exist yet. Lets
                      the operator manually fire the bracket — needed in real
                      mode and as a fallback if paper auto-execute failed. */}
                  {!needsQueenApproval
                    && !needsIntervention
                    && finalVerdict
                    && finalVerdict.stance !== "STAND_DOWN"
                    && execSnapshot
                    && execSnapshot.orders.length === 0
                    && !execSnapshot.position
                    /* Suppress the manual button while a paper-mode
                       auto-execute is in flight — otherwise the operator
                       sees both the "auto-submitted" banner AND a manual
                       button during the brief window before the order rows
                       appear in execSnapshot, and a second click would
                       lose the single-flight race and dump an ERROR
                       packet into the feed. */
                    && !(approveOutcome?.autoExecuteScheduled) ? (
                    <div data-testid="post-approval-execute" className="mb-3">
                      <div className="mb-2 font-mono text-[10px] tracking-widest text-muted-foreground">
                        TRADE PLAN READY · {finalVerdict.tradePlan.symbol} · {finalVerdict.tradePlan.bias}
                      </div>
                      {execError && (
                        <div className="p-2 mb-2 bg-destructive/10 border border-destructive/40 rounded-sm font-mono text-[11px] text-destructive" data-testid="exec-error-postapprove">
                          {execError}
                        </div>
                      )}
                      <Button
                        onClick={handleLockExecute}
                        disabled={executeMission.isPending}
                        className="w-full h-11 bg-chart-5 hover:bg-chart-5/90 text-chart-5-foreground font-mono font-bold tracking-wider rounded-sm shadow-[0_0_15px_hsl(var(--chart-5)/0.3)] disabled:opacity-30"
                        data-testid="btn-execute-trade-now"
                        title="Submit the locked Queen trade plan as a bracket order (entry + stop + TP1/TP2)."
                      >
                        <Zap className="w-4 h-4 mr-2" />
                        {executeMission.isPending ? "SUBMITTING…" : "EXECUTE TRADE NOW"}
                      </Button>
                    </div>
                  ) : null}
                  {needsQueenApproval && finalVerdict ? (
                    <div data-testid="final-verdict">
                      {/* Stance + headline */}
                      <div className="flex items-center gap-2 mb-3 flex-wrap">
                        <span
                          className={`px-3 py-1 rounded-sm font-mono font-bold text-[11px] tracking-widest ${
                            finalVerdict.stance === "CONFIRM"
                              ? "bg-chart-2/20 text-chart-2 border border-chart-2/40"
                              : finalVerdict.stance === "COUNTER"
                              ? "bg-chart-4/20 text-chart-4 border border-chart-4/40"
                              : "bg-destructive/20 text-destructive border border-destructive/40"
                          }`}
                          data-testid="final-verdict-stance"
                        >
                          {finalVerdict.stance}
                        </span>
                        <span className="font-mono text-[11px] text-muted-foreground tracking-wider">
                          CYCLE {finalVerdict.cycle}
                        </span>
                      </div>
                      {finalVerdict.headline && finalVerdict.headline !== "—" && (
                        <p className="font-mono text-[12px] text-foreground/90 mb-3 leading-snug">
                          {finalVerdict.headline}
                        </p>
                      )}

                      {/* Trade plan grid */}
                      <div className="mb-3 p-3 bg-secondary/50 border border-border rounded-sm font-mono">
                        <div className="flex items-baseline gap-3 mb-3 pb-2 border-b border-border/60">
                          <span className="text-xl font-bold text-foreground tracking-wider" data-testid="final-verdict-symbol">
                            {finalVerdict.tradePlan.symbol}
                          </span>
                          <span className={`px-2 py-0.5 rounded-sm text-[11px] font-bold tracking-widest ${
                            finalVerdict.tradePlan.bias === "LONG" ? "bg-chart-2/20 text-chart-2"
                            : finalVerdict.tradePlan.bias === "SHORT" ? "bg-destructive/20 text-destructive"
                            : "bg-muted text-muted-foreground"
                          }`} data-testid="final-verdict-bias">
                            {finalVerdict.tradePlan.bias}
                          </span>
                          {finalVerdict.selectedTimeframe && (
                            <span
                              className="px-1.5 py-0.5 rounded-sm text-[10px] font-bold tracking-widest bg-chart-3/15 text-chart-3 border border-chart-3/30"
                              data-testid="final-verdict-timeframe"
                              title="Timeframe selected by the Queen for this verdict"
                            >
                              {finalVerdict.selectedTimeframe.toUpperCase()}
                            </span>
                          )}
                          <span className="ml-auto text-[10px] text-muted-foreground tracking-widest">
                            R:R {finalVerdict.tradePlan.rr}
                          </span>
                        </div>
                        {(finalVerdict.promotionReason || finalVerdict.reanchorReason) && (
                          <div className="mb-3 p-2 bg-chart-3/5 border border-chart-3/30 rounded-sm">
                            <div className="text-[9px] font-bold tracking-widest text-chart-3 mb-1">
                              ADAPTIVE TIMING
                            </div>
                            {finalVerdict.promotionReason && (
                              <div className="text-[11px] text-foreground/80 leading-snug" data-testid="final-verdict-promotion-reason">
                                <span className="text-muted-foreground tracking-widest mr-1">PROMOTED:</span>
                                {finalVerdict.promotionReason}
                              </div>
                            )}
                            {finalVerdict.reanchorReason && (
                              <div className="text-[11px] text-foreground/80 leading-snug mt-1" data-testid="final-verdict-reanchor-reason">
                                <span className="text-muted-foreground tracking-widest mr-1">RE-ANCHORED:</span>
                                {finalVerdict.reanchorReason}
                              </div>
                            )}
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                          <div><span className="text-muted-foreground tracking-widest">ENTRY</span><div className="text-foreground/90">{finalVerdict.tradePlan.entry}</div></div>
                          <div><span className="text-muted-foreground tracking-widest">STOP</span><div className="text-destructive/90">{finalVerdict.tradePlan.stop}</div></div>
                          <div><span className="text-muted-foreground tracking-widest">TP1</span><div className="text-chart-2/90">{finalVerdict.tradePlan.tp1}</div></div>
                          <div><span className="text-muted-foreground tracking-widest">TP2</span><div className="text-chart-2/90">{finalVerdict.tradePlan.tp2}</div></div>
                          <div className="col-span-2"><span className="text-muted-foreground tracking-widest">SIZING</span><div className="text-foreground/90">{finalVerdict.tradePlan.sizing}</div></div>
                        </div>
                        {finalVerdict.rationale && (
                          <div className="mt-3 pt-2 border-t border-border/60 text-[11px] text-foreground/75 leading-relaxed whitespace-pre-wrap">
                            {finalVerdict.rationale}
                          </div>
                        )}
                      </div>

                      {/* LOCK & EXECUTE / STAND DOWN buttons */}
                      {execError && (
                        <div className="p-2 mb-2 bg-destructive/10 border border-destructive/40 rounded-sm font-mono text-[11px] text-destructive" data-testid="exec-error">
                          {execError}
                        </div>
                      )}
                      <div className="flex flex-col md:flex-row gap-3">
                        <Button
                          onClick={handleLockExecute}
                          disabled={executeMission.isPending || queenVeto.isPending || finalVerdict.stance === "STAND_DOWN"}
                          className="flex-1 h-11 bg-chart-5 hover:bg-chart-5/90 text-chart-5-foreground font-mono font-bold tracking-wider rounded-sm shadow-[0_0_15px_hsl(var(--chart-5)/0.3)] disabled:opacity-30"
                          data-testid="btn-lock-execute"
                          title={finalVerdict.stance === "STAND_DOWN" ? "Queen verdict is STAND_DOWN — execution disabled" : "Submit bracket order (entry + stop + TP1/TP2) per the EXECUTION config"}
                        >
                          <Zap className="w-4 h-4 mr-2" />
                          {executeMission.isPending ? "SUBMITTING…" : "LOCK & EXECUTE"}
                        </Button>
                        <Button
                          onClick={() => {
                            if (!id) return;
                            const reason = `Stand down per Queen final verdict (${finalVerdict.stance}): ${finalVerdict.headline || finalVerdict.rationale.substring(0, 200) || "no edge"}`;
                            queenVeto.mutate(
                              { id, data: { reason } },
                              { onSuccess: () => { refetchStatus(); refetchMission(); refetchPackets(); } }
                            );
                          }}
                          disabled={queenVeto.isPending || queenApprove.isPending}
                          variant="destructive"
                          className="flex-1 h-11 font-mono font-bold tracking-wider rounded-sm shadow-[0_0_15px_hsl(var(--destructive)/0.3)]"
                          data-testid="btn-stand-down"
                        >
                          <X className="w-4 h-4 mr-2" />
                          STAND DOWN
                        </Button>
                      </div>
                    </div>
                  ) : needsQueenApproval ? (
                    <div>
                      <div className="mb-3 p-3 bg-secondary/50 border border-border rounded-sm font-mono text-xs">
                        <span className="text-muted-foreground block mb-2 text-[10px] tracking-widest">PROPOSED THESIS LOCK:</span>
                        {mission.thesisLock || "No thesis lock data available."}
                      </div>
                      <div className="flex flex-col md:flex-row gap-3">
                        <Button
                          onClick={handleApprove}
                          disabled={queenApprove.isPending || queenVeto.isPending}
                          className="flex-1 h-11 bg-chart-5 hover:bg-chart-5/90 text-chart-5-foreground font-mono font-bold tracking-wider rounded-sm shadow-[0_0_15px_hsl(var(--chart-5)/0.3)]"
                          data-testid="btn-approve"
                        >
                          <Check className="w-4 h-4 mr-2" />
                          LOCK THESIS
                        </Button>
                        <div className="flex-1 flex gap-2">
                          <Textarea
                            placeholder="Enter veto reasoning..."
                            value={vetoReason}
                            onChange={(e) => setVetoReason(e.target.value)}
                            className="font-mono bg-background border-border min-h-[44px] rounded-sm text-xs"
                            data-testid="input-veto-reason"
                          />
                          <Button
                            onClick={handleVeto}
                            disabled={!vetoReason || queenVeto.isPending || queenApprove.isPending}
                            variant="destructive"
                            className="h-full px-4 font-mono font-bold tracking-wider rounded-sm shrink-0 shadow-[0_0_15px_hsl(var(--destructive)/0.3)]"
                            data-testid="btn-veto"
                          >
                            <X className="w-4 h-4 mr-2" />
                            VETO
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : needsIntervention ? (
                    <div>
                      <p className="font-mono text-[11px] text-muted-foreground mb-3">
                        Workers ran {debateOptions.length} debate cycles but couldn't push past 0.85. Pick a direction below — they'll resume around your choice.
                      </p>
                      {debateOptions.length === 0 ? (
                        <div className="font-mono text-xs text-muted-foreground p-3 border border-border rounded-sm">
                          Loading debate history...
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
                          {debateOptions.slice(0, 3).map((opt, idx) => {
                            const isSelected = selectedPacketId === opt.id;
                            return (
                              <button
                                key={opt.id}
                                onClick={() => setSelectedPacketId(opt.id)}
                                data-testid={`option-${idx}`}
                                title={opt.proposal}
                                className={`text-left p-3 rounded-sm border-2 font-mono text-[11px] transition-all ${
                                  isSelected
                                    ? "border-chart-3 bg-chart-3/10 shadow-[0_0_15px_hsl(var(--chart-3)/0.3)]"
                                    : "border-border bg-background/40 hover:border-chart-3/50 hover:bg-chart-3/5"
                                }`}
                              >
                                <div className="flex justify-between items-center mb-2">
                                  <span className={`font-bold tracking-widest text-[10px] ${isSelected ? "text-chart-3" : "text-muted-foreground"}`}>
                                    OPT {String.fromCharCode(65 + idx)} · C{opt.cycle}
                                  </span>
                                  <span className={`px-1.5 py-0.5 rounded-sm text-[10px] ${
                                    opt.score >= 0.8 ? "bg-chart-2/20 text-chart-2" : opt.score >= 0.6 ? "bg-chart-4/20 text-chart-4" : "bg-muted text-muted-foreground"
                                  }`}>
                                    {opt.score.toFixed(2)}
                                  </span>
                                </div>
                                <div className="flex items-baseline gap-2 mb-2">
                                  <span className="text-lg font-bold text-foreground tracking-wider" data-testid={`option-${idx}-symbol`}>
                                    {opt.symbol}
                                  </span>
                                  <span className={`px-2 py-0.5 rounded-sm text-[11px] font-bold tracking-widest ${
                                    opt.bias === "LONG" ? "bg-chart-2/20 text-chart-2"
                                    : opt.bias === "SHORT" ? "bg-destructive/20 text-destructive"
                                    : "bg-muted text-muted-foreground"
                                  }`} data-testid={`option-${idx}-bias`}>
                                    {opt.bias}
                                  </span>
                                </div>
                                {opt.rationale && (
                                  <div className="text-foreground/85 leading-relaxed text-[12px] whitespace-normal break-words">
                                    {opt.rationale}
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <div className="flex flex-col md:flex-row gap-2 items-stretch">
                        <Textarea
                          placeholder="OPTIONAL refinement on top of your selected anchor..."
                          value={refinement}
                          onChange={(e) => setRefinement(e.target.value)}
                          className="font-mono bg-background border-border min-h-[56px] rounded-sm flex-1 text-[11px]"
                          data-testid="input-refinement"
                        />
                        <Button
                          onClick={handleIntervene}
                          disabled={!selectedPacketId || queenIntervene.isPending}
                          className="md:w-56 px-4 bg-chart-3 hover:bg-chart-3/90 text-background font-mono font-bold tracking-wider rounded-sm shrink-0 shadow-[0_0_15px_hsl(var(--chart-3)/0.3)] disabled:opacity-40"
                          data-testid="btn-intervene"
                        >
                          <Crown className="w-4 h-4 mr-2" />
                          {queenIntervene.isPending ? "ANCHORING..." : "ANCHOR & RESUME"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="h-full min-h-[120px] flex flex-col items-center justify-center text-muted-foreground font-mono text-[11px] tracking-widest text-center">
                      <Crown className="w-8 h-8 mb-2 text-chart-5/40" />
                      <p>QUEEN STANDING BY</p>
                      <p className="text-[10px] mt-1 opacity-70">
                        Approval &amp; intervention controls appear here when workers reach a checkpoint.
                      </p>
                    </div>
                  )}
                </div>
              </MissionWidget>

              {/* EXECUTION LIFECYCLE PANEL — visible whenever a mission has
                  any execution rows. Polls /missions/:id/execution every 4s
                  via useGetMissionExecution. KILL is a no-op when nothing is
                  open. */}
              {execSnapshot && (execSnapshot.orders.length > 0 || execSnapshot.position) && (
                <Card className="bg-card border-primary/40 rounded-sm shadow-[0_0_18px_hsl(var(--primary)/0.15)]" data-testid="exec-panel">
                  {(() => {
                    const isPaper = execSnapshot.position?.paper
                      ?? execSnapshot.orders.some((o) => o.paper);
                    return (
                      <div className={`px-3 py-1.5 border-b flex items-center gap-2 ${isPaper ? "bg-chart-3/15 border-chart-3/40" : "bg-primary/15 border-primary/40"}`}>
                        <Zap className={`w-4 h-4 ${isPaper ? "text-chart-3" : "text-primary"}`} />
                        <span className={`font-mono text-[11px] font-bold tracking-widest uppercase ${isPaper ? "text-chart-3" : "text-primary"}`}>
                          EXECUTION · {isPaper ? "PAPER" : "LIVE"}
                        </span>
                      </div>
                    );
                  })()}
                  <div className="p-3 space-y-3 font-mono text-[11px]">
                    {execSnapshot.position && (
                      <div className={`p-2 rounded-sm border ${execSnapshot.position.status === "open"
                        ? "bg-chart-2/10 border-chart-2/40"
                        : "bg-secondary/40 border-border"}`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="tracking-widest font-bold">
                            {execSnapshot.position.symbol} · {execSnapshot.position.side.toUpperCase()}
                            {execSnapshot.position.paper && (
                              <span className="ml-2 text-[9px] px-1.5 py-0.5 bg-chart-3/20 text-chart-3 rounded-sm">PAPER</span>
                            )}
                          </span>
                          <span className={`text-[10px] tracking-widest ${execSnapshot.position.status === "open"
                            ? "text-chart-2" : execSnapshot.position.status === "killed"
                            ? "text-destructive" : "text-muted-foreground"}`}>
                            {execSnapshot.position.status.toUpperCase()}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-[10px]">
                          <div><span className="text-muted-foreground">SIZE</span><div>{execSnapshot.position.sz}</div></div>
                          <div><span className="text-muted-foreground">ENTRY</span><div>{execSnapshot.position.entryPx}</div></div>
                          <div>
                            <span className="text-muted-foreground">uPnL</span>
                            <div className={execSnapshot.position.unrealizedPnlUsd >= 0 ? "text-chart-2" : "text-destructive"}>
                              ${execSnapshot.position.unrealizedPnlUsd.toFixed(2)}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="space-y-1">
                      <div className="text-[9px] tracking-widest text-muted-foreground">ORDERS ({execSnapshot.orders.length})</div>
                      {execSnapshot.orders.map((o) => (
                        <div key={o.id} className="flex items-center justify-between py-1 border-b border-border/40 last:border-0">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="w-12 text-[10px] tracking-widest text-foreground/80 shrink-0">{o.kind.toUpperCase()}</span>
                            <span className="text-[10px] text-muted-foreground shrink-0">{o.side.toUpperCase()} {o.sz}</span>
                            {o.triggerPx != null && <span className="text-[10px] text-muted-foreground shrink-0">@ {o.triggerPx}</span>}
                            {o.hlOrderId && (
                              <span
                                className="text-[10px] text-muted-foreground/70 font-mono truncate"
                                title={`Hyperliquid order id: ${o.hlOrderId}`}
                                data-testid={`exec-order-oid-${o.id}`}
                              >
                                #{o.hlOrderId}
                              </span>
                            )}
                            {o.filledSz > 0 && o.avgFillPx != null && (
                              <span className="text-[10px] text-chart-2 shrink-0">
                                fill {o.filledSz} @ {o.avgFillPx}
                              </span>
                            )}
                            {o.errorMessage && <span className="text-[10px] text-destructive truncate max-w-[200px]" title={o.errorMessage}>{o.errorMessage}</span>}
                          </span>
                          <span className={`text-[10px] tracking-widest ${
                            o.status === "filled" ? "text-chart-2"
                            : o.status === "open" ? "text-chart-5"
                            : o.status === "rejected" || o.status === "error" ? "text-destructive"
                            : "text-muted-foreground"
                          }`}>{o.status.toUpperCase()}</span>
                        </div>
                      ))}
                    </div>

                    {(execSnapshot.position?.status === "open" || execSnapshot.orders.some((o) => o.status === "open")) && (
                      <Button
                        onClick={handleKillExecution}
                        disabled={killExecution.isPending}
                        variant="destructive"
                        className="w-full h-9 font-mono font-bold tracking-wider rounded-sm shadow-[0_0_12px_hsl(var(--destructive)/0.3)]"
                        data-testid="btn-kill-execution"
                      >
                        <Square className="w-3.5 h-3.5 mr-2" />
                        {killExecution.isPending ? "KILLING…" : "KILL · CANCEL ALL & FLAT-CLOSE"}
                      </Button>
                    )}
                  </div>
                </Card>
              )}

              <MissionLedgerPanel missionId={mission.id} />
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}

function MissionLedgerPanel({ missionId }: { missionId: number }) {
  const { data, isLoading, refetch, isFetching } = useGetMissionLedger(missionId, {
    query: { refetchInterval: 8000, queryKey: ["mission-ledger", missionId] },
  });
  const verify = useVerifyMissionLedger(missionId, {
    query: { refetchInterval: 15000, queryKey: ["mission-ledger-verify", missionId] },
  });
  const entries = data?.entries ?? [];
  if (isLoading) return null;
  if (entries.length === 0 && verify.data?.totalEntries === 0) return null;

  const ok = verify.data?.ok;
  const lastHash = verify.data?.lastHash;
  const missionEntries = verify.data?.missionEntries ?? entries.length;

  const downloadExport = () => {
    window.location.href = `${import.meta.env.BASE_URL}api/ledger/export`;
  };

  const actionColor: Record<string, string> = {
    submit: "text-chart-4", fill: "text-chart-2", cancel: "text-muted-foreground",
    kill: "text-destructive", close: "text-chart-5", error: "text-destructive",
  };

  return (
    <Card className="bg-card border-border rounded-sm" data-testid="mission-ledger-panel">
      <div className="px-3 py-1.5 border-b border-border bg-secondary/40 flex items-center gap-2">
        <Database className="w-4 h-4 text-primary" />
        <span className="font-mono text-[11px] font-bold tracking-widest uppercase text-primary">
          LEDGER · MSN-{missionId}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span
            className={`px-2 py-0.5 rounded-sm border font-mono text-[9px] tracking-widest ${
              ok == null ? "border-border text-muted-foreground"
                : ok ? "border-chart-2/50 text-chart-2 bg-chart-2/5"
                : "border-destructive/50 text-destructive bg-destructive/5"
            }`}
            data-testid="mission-ledger-verify"
          >
            <ShieldCheck className="w-3 h-3 inline mr-1" />
            {ok == null ? "VERIFYING" : ok ? "CHAIN OK" : `BROKEN @ ${verify.data?.brokeAtIndex}`}
          </span>
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => { refetch(); verify.refetch(); }} data-testid="btn-refresh-mission-ledger">
            <Activity className={`w-3 h-3 ${isFetching ? "animate-pulse" : ""}`} />
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={downloadExport} data-testid="btn-export-mission-ledger">
            <Download className="w-3 h-3" />
          </Button>
        </span>
      </div>
      <div className="p-2 font-mono text-[10px] text-muted-foreground border-b border-border/50">
        {missionEntries} ENTRIES FOR THIS MISSION · LAST {lastHash ? lastHash.slice(0, 12) + "…" : "—"}
      </div>
      <div className="divide-y divide-border/40 max-h-[280px] overflow-y-auto">
        {entries.map((e) => (
          <div key={`${e.index}-${e.hash}`} className="px-3 py-1.5 font-mono text-[10px]" data-testid={`mission-ledger-row-${e.index}`}>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-10 text-right">#{e.index}</span>
              <span className="text-muted-foreground">
                {(() => { try { return new Date(e.ts).toLocaleTimeString(); } catch { return e.ts; } })()}
              </span>
              <span className={`font-bold w-14 ${actionColor[e.action] ?? "text-foreground"}`}>{e.action.toUpperCase()}</span>
              <span className="text-foreground/80 truncate flex-1">
                {typeof e.payload === "object" && e.payload && "summary" in (e.payload as Record<string, unknown>)
                  ? String((e.payload as Record<string, unknown>).summary)
                  : ""}
              </span>
              <span className="text-muted-foreground/60">{e.hash.slice(0, 10)}…</span>
            </div>
          </div>
        ))}
        {entries.length === 0 && (
          <div className="p-3 text-center font-mono text-[10px] text-muted-foreground">
            NO LEDGER ENTRIES YET — APPEAR ON FIRST EXECUTION EVENT.
          </div>
        )}
      </div>
    </Card>
  );
}

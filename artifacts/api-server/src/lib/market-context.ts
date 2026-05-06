// Compact MULTI-TIMEFRAME market-context blob injected into agent system
// prompts when a mission has a target symbol. Pulls candles from 5m, 15m, 1h,
// 4h, and 1d in parallel so the debate can anchor entries / stops / TPs to
// real higher-timeframe structure rather than guessing from 50 5m bars.
//
// Cached briefly so a single debate cycle hits Hyperliquid at most once per
// timeframe (all five agents in a cycle share one snapshot).
import {
  getMarketSnapshot,
  getCandleSnapshot,
  type MarketSnapshot,
  type Candle,
  type CandleInterval,
} from "./hyperliquid-client";
import { logger } from "./logger";

// Timeframes the debate inspects, in increasing order of "structural weight".
// 5m stays for execution detail; the rest provide the higher-timeframe
// context the AI uses to place levels precisely.
export const HTF_TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"] as const;
export type HtfTimeframe = (typeof HTF_TIMEFRAMES)[number];

// How many bars to fetch per timeframe. Calibrated so the resulting prompt
// block stays around 4-6 KB (under 2× the previous single-timeframe size).
const BARS_PER_TF: Record<HtfTimeframe, number> = {
  "5m": 40,
  "15m": 24,
  "1h": 30,
  "4h": 24,
  "1d": 21,
};

// Per-timeframe structural summary — pre-computed numeric features so the
// LLM doesn't have to re-derive them from raw bars (saves tokens & avoids
// hallucinated levels).
export type TimeframeSummary = {
  interval: HtfTimeframe;
  barCount: number;
  lastClose: number;
  // Simple trend bias: sign of (lastClose - SMA(N)) normalized by ATR.
  // "up"   when lastClose > SMA + 0.25*ATR
  // "down" when lastClose < SMA - 0.25*ATR
  // "flat" otherwise
  trend: "up" | "down" | "flat";
  // Average true range proxy: mean(high - low) over the lookback window.
  atr: number;
  // Highest high / lowest low across the entire lookback window.
  rangeHigh: number;
  rangeLow: number;
  // Pivot swing highs/lows (bar that is the local max/min within ±2 bars).
  // Top 3 most-recent of each, newest-first, as [time, price] pairs so the
  // agent can quote both anchor and value.
  swingHighs: Array<[number, number]>;
  swingLows: Array<[number, number]>;
  // Daily-only: the prior fully-closed day's high/low (yesterday's bar).
  // Null on intraday timeframes.
  priorDayHigh: number | null;
  priorDayLow: number | null;
};

export type MarketContext = {
  symbol: string;
  fetchedAt: number; // ms epoch
  snapshot: MarketSnapshot;
  // Raw candle arrays per timeframe (trimmed to BARS_PER_TF entries).
  candlesByTf: Record<HtfTimeframe, Candle[]>;
  // Pre-computed structural summary per timeframe.
  summaries: Record<HtfTimeframe, TimeframeSummary>;
};

const CACHE_TTL_MS = 2_000;
const cache = new Map<string, { ctx: MarketContext; expiresAt: number }>();

export async function buildMarketContext(symbol: string): Promise<MarketContext> {
  const sym = symbol.toUpperCase();
  const hit = cache.get(sym);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.ctx;

  const candleFetches = HTF_TIMEFRAMES.map((tf) =>
    getCandleSnapshot(sym, tf as CandleInterval, BARS_PER_TF[tf]),
  );
  const [snapshot, ...candleArrays] = await Promise.all([
    getMarketSnapshot(sym),
    ...candleFetches,
  ]);

  const candlesByTf = {} as Record<HtfTimeframe, Candle[]>;
  const summaries = {} as Record<HtfTimeframe, TimeframeSummary>;
  HTF_TIMEFRAMES.forEach((tf, i) => {
    candlesByTf[tf] = candleArrays[i];
    summaries[tf] = summarizeTimeframe(tf, candleArrays[i]);
  });

  const ctx: MarketContext = { symbol: sym, fetchedAt: now, snapshot, candlesByTf, summaries };
  cache.set(sym, { ctx, expiresAt: now + CACHE_TTL_MS });
  return ctx;
}

// ─── Structural derivation ──────────────────────────────────────────────────

function summarizeTimeframe(interval: HtfTimeframe, bars: Candle[]): TimeframeSummary {
  if (bars.length === 0) {
    return {
      interval,
      barCount: 0,
      lastClose: 0,
      trend: "flat",
      atr: 0,
      rangeHigh: 0,
      rangeLow: 0,
      swingHighs: [],
      swingLows: [],
      priorDayHigh: null,
      priorDayLow: null,
    };
  }

  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const ranges = bars.map((b) => b.high - b.low);

  const lastClose = closes[closes.length - 1];
  const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
  const atr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);

  // Trend bias relative to ATR-scaled distance from SMA.
  let trend: "up" | "down" | "flat" = "flat";
  if (atr > 0) {
    if (lastClose > sma + 0.25 * atr) trend = "up";
    else if (lastClose < sma - 0.25 * atr) trend = "down";
  }

  // Swing pivots: bar i is a swing high if bars[i].high is the local max
  // within bars[i-K..i+K] for K=2. Same idea inverted for swing lows. We
  // only consider bars with at least K bars on each side.
  const K = 2;
  const swingHighs: Array<[number, number]> = [];
  const swingLows: Array<[number, number]> = [];
  for (let i = K; i < bars.length - K; i++) {
    const window = bars.slice(i - K, i + K + 1);
    const maxH = Math.max(...window.map((b) => b.high));
    const minL = Math.min(...window.map((b) => b.low));
    if (bars[i].high === maxH) swingHighs.push([bars[i].time, bars[i].high]);
    if (bars[i].low === minL) swingLows.push([bars[i].time, bars[i].low]);
  }
  // Keep the 3 most recent of each (newest-first ordering for prompt clarity).
  const topSwingHighs = swingHighs.slice(-3).reverse();
  const topSwingLows = swingLows.slice(-3).reverse();

  // Prior-day H/L: only meaningful on the daily timeframe. Take yesterday's
  // closed bar (the second-to-last entry; the last bar may be the live day).
  let priorDayHigh: number | null = null;
  let priorDayLow: number | null = null;
  if (interval === "1d" && bars.length >= 2) {
    const yday = bars[bars.length - 2];
    priorDayHigh = yday.high;
    priorDayLow = yday.low;
  }

  return {
    interval,
    barCount: bars.length,
    lastClose,
    trend,
    atr,
    rangeHigh,
    rangeLow,
    swingHighs: topSwingHighs,
    swingLows: topSwingLows,
    priorDayHigh,
    priorDayLow,
  };
}

// ─── Prompt-block formatter ─────────────────────────────────────────────────

// How many raw bars to embed per timeframe in the prompt. We send full bar
// arrays only for the lower timeframes (5m, 15m) where individual candles
// matter for execution detail. Higher timeframes ride on their summary plus
// a trimmed bar list; the LLM rarely needs every single 4h candle's OHLC.
const PROMPT_BARS_PER_TF: Record<HtfTimeframe, number> = {
  "5m": 30,
  "15m": 16,
  "1h": 16,
  "4h": 12,
  "1d": 10,
};

export function formatMarketContextBlock(ctx: MarketContext): string {
  const s = ctx.snapshot;
  const tfBlock = HTF_TIMEFRAMES.map((tf) => formatTfBlock(tf, ctx));
  const compact = {
    symbol: ctx.symbol,
    asOfIso: new Date(ctx.fetchedAt).toISOString(),
    markPrice: round(s.markPrice, 4),
    midPrice: s.midPrice != null ? round(s.midPrice, 4) : null,
    bid: s.bid != null ? round(s.bid, 4) : null,
    ask: s.ask != null ? round(s.ask, 4) : null,
    spreadBps: s.spreadBps != null ? round(s.spreadBps, 2) : null,
    changePct24h: round(s.changePct24h, 3),
    fundingRateHourly: round(s.fundingRate, 6),
    openInterest: round(s.openInterest, 2),
    dayVolumeUsd: round(s.dayVolumeUsd, 0),
    // candleSchema applies to every "bars" array across every timeframe.
    candleSchema: "[utcSec, o, h, l, c, vol]",
    timeframes: Object.fromEntries(tfBlock),
  };
  return [
    "=== MARKET CONTEXT (MULTI-TIMEFRAME SNAPSHOT — DO NOT TRUST FOR EXECUTION) ===",
    "Live Hyperliquid perp data captured for THIS debate cycle. Prices move; treat as a snapshot at asOfIso.",
    "Each entry under `timeframes` carries:",
    "  trend         = simple bias (up/down/flat) of lastClose vs the SMA over the lookback window",
    "  atr           = mean(high-low) over the lookback window — use it to size stops and gauge wick noise",
    "  rangeHigh/Low = highest high / lowest low across the whole window",
    "  swingHighs[]  = recent pivot highs as [utcSec, price], newest-first — anchor candidate stops above these on shorts",
    "  swingLows[]   = recent pivot lows as [utcSec, price], newest-first — anchor candidate stops below these on longs",
    "  priorDayHigh/Low = yesterday's full session range (1d only)",
    "  bars          = trimmed OHLCV array, oldest-first, schema in candleSchema",
    "Cite levels by timeframe AND value (e.g. '4h swing high 76,540') when justifying entries, stops, or take-profits.",
    "```json",
    JSON.stringify(compact),
    "```",
    "=== END MARKET CONTEXT ===",
  ].join("\n");
}

function formatTfBlock(tf: HtfTimeframe, ctx: MarketContext): [string, unknown] {
  const sum = ctx.summaries[tf];
  const cap = PROMPT_BARS_PER_TF[tf];
  const candles = ctx.candlesByTf[tf];
  const trimmed = candles.length > cap ? candles.slice(-cap) : candles;
  return [
    tf,
    {
      trend: sum.trend,
      lastClose: round(sum.lastClose, 4),
      atr: round(sum.atr, 4),
      rangeHigh: round(sum.rangeHigh, 4),
      rangeLow: round(sum.rangeLow, 4),
      swingHighs: sum.swingHighs.map(([t, p]) => [t, round(p, 4)]),
      swingLows: sum.swingLows.map(([t, p]) => [t, round(p, 4)]),
      priorDayHigh: sum.priorDayHigh != null ? round(sum.priorDayHigh, 4) : null,
      priorDayLow: sum.priorDayLow != null ? round(sum.priorDayLow, 4) : null,
      bars: trimmed.map((c) => [c.time, c.open, c.high, c.low, c.close, round(c.volume, 2)]),
    },
  ];
}

function round(n: number, dp: number): number {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

export async function safeBuildContextBlock(
  symbol: string | null | undefined,
): Promise<{ ctx: MarketContext | null; block: string }> {
  if (!symbol) return { ctx: null, block: "" };
  try {
    const ctx = await buildMarketContext(symbol);
    return { ctx, block: formatMarketContextBlock(ctx) };
  } catch (err) {
    logger.warn({ err, symbol }, "market-context fetch failed; agents will run blind");
    return { ctx: null, block: "" };
  }
}

// ─── Level validation (used by Observer to penalise unsubstantiated levels) ─

export type LevelCitation = {
  // Label parsed from the proposal (e.g. "Stop", "Entry", "TP1").
  label: string;
  price: number;
  // Closest known level across all higher timeframes, or null if no match
  // within tolerance.
  nearest: { timeframe: HtfTimeframe; kind: string; price: number; distancePct: number } | null;
};

// Tolerance: the proposed price is "matched" to a known structural level if
// they sit within max(0.4% of price, 0.4 * 1h ATR). 0.4% catches round-number
// targets; ATR-scaled catches looser levels in volatile coins.
function tolerance(price: number, atr1h: number): number {
  return Math.max(price * 0.004, atr1h * 0.4);
}

// Build a flat catalog of named levels from every HTF summary. Used both
// for matching and for the human-readable validation report.
function catalogLevels(ctx: MarketContext): Array<{
  timeframe: HtfTimeframe;
  kind: string;
  price: number;
}> {
  const out: Array<{ timeframe: HtfTimeframe; kind: string; price: number }> = [];
  for (const tf of HTF_TIMEFRAMES) {
    const s = ctx.summaries[tf];
    out.push({ timeframe: tf, kind: "rangeHigh", price: s.rangeHigh });
    out.push({ timeframe: tf, kind: "rangeLow", price: s.rangeLow });
    s.swingHighs.forEach(([, p]) => out.push({ timeframe: tf, kind: "swingHigh", price: p }));
    s.swingLows.forEach(([, p]) => out.push({ timeframe: tf, kind: "swingLow", price: p }));
    if (s.priorDayHigh != null) out.push({ timeframe: tf, kind: "priorDayHigh", price: s.priorDayHigh });
    if (s.priorDayLow != null) out.push({ timeframe: tf, kind: "priorDayLow", price: s.priorDayLow });
  }
  return out.filter((l) => Number.isFinite(l.price) && l.price > 0);
}

// Crude parser for the labelled price lines emitted by Strategist/Synthesizer.
// We look for `Entry`, `Stop`, `Invalidation`, `TP1`, `TP2`, `TP3`, optionally
// followed by a colon, then capture the first numeric price (or the upper end
// of a range like "76,000–76,120"). Numbers may use commas as thousands sep.
const LABEL_RE = /\b(Entry(?:\s+zone)?|Invalidation(?:\s*\/\s*stop)?|Stop|TP\s*[1-3]|Take[-\s]?profit(?:\s*[1-3])?)\b\s*[:\-–]?\s*([0-9][0-9,]*\.?[0-9]*)(?:\s*[–-]\s*([0-9][0-9,]*\.?[0-9]*))?/gi;

function parseProposalLevels(text: string): Array<{ label: string; price: number }> {
  const out: Array<{ label: string; price: number }> = [];
  for (const m of text.matchAll(LABEL_RE)) {
    const label = m[1].replace(/\s+/g, " ").trim();
    const a = parseFloat(m[2].replace(/,/g, ""));
    const b = m[3] ? parseFloat(m[3].replace(/,/g, "")) : NaN;
    if (Number.isFinite(a)) out.push({ label, price: a });
    if (Number.isFinite(b)) out.push({ label: `${label} (upper)`, price: b });
  }
  return out;
}

// Anchor claims emitted in the "=== HTF LEVEL ANCHORS ===" section. Format
// the prompts ask for:
//   - <LevelName> @ <price> ← <timeframe> <kind> <value>
// We accept "←", "<-", or "<=" as the arrow. timeframe is one of HTF_TIMEFRAMES;
// kind is one of swingHigh/swingLow/rangeHigh/rangeLow/priorDayHigh/priorDayLow
// (case-insensitive, with optional spacing/hyphens).
const ANCHOR_RE = /-\s*([A-Za-z0-9 _\/\-]+?)\s*@\s*([0-9][0-9,]*\.?[0-9]*)\s*(?:←|<-|<=)\s*(5m|15m|1h|4h|1d)\s+([A-Za-z\- ]+?)\s+([0-9][0-9,]*\.?[0-9]*)/gi;

const KIND_ALIASES: Record<string, string> = {
  swinghigh: "swingHigh",
  "swing-high": "swingHigh",
  "swing high": "swingHigh",
  swinglow: "swingLow",
  "swing-low": "swingLow",
  "swing low": "swingLow",
  rangehigh: "rangeHigh",
  "range high": "rangeHigh",
  rangelow: "rangeLow",
  "range low": "rangeLow",
  priordayhigh: "priorDayHigh",
  "prior day high": "priorDayHigh",
  "prior-day high": "priorDayHigh",
  pdh: "priorDayHigh",
  priordaylow: "priorDayLow",
  "prior day low": "priorDayLow",
  "prior-day low": "priorDayLow",
  pdl: "priorDayLow",
};

function normalizeKind(raw: string): string {
  const k = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return KIND_ALIASES[k] ?? raw.trim();
}

export type AnchorClaim = {
  label: string;
  price: number;
  claimedTimeframe: HtfTimeframe;
  claimedKind: string;
  claimedValue: number;
  // True if the claim semantically matches a real catalog entry (same
  // timeframe + kind, value within tolerance of the actual catalog price).
  matches: boolean;
};

function parseAnchorClaims(text: string): Array<{
  label: string;
  price: number;
  claimedTimeframe: HtfTimeframe;
  claimedKind: string;
  claimedValue: number;
}> {
  const out: Array<{
    label: string;
    price: number;
    claimedTimeframe: HtfTimeframe;
    claimedKind: string;
    claimedValue: number;
  }> = [];
  for (const m of text.matchAll(ANCHOR_RE)) {
    const label = m[1].trim();
    const price = parseFloat(m[2].replace(/,/g, ""));
    const tf = m[3].toLowerCase() as HtfTimeframe;
    const kind = normalizeKind(m[4]);
    const val = parseFloat(m[5].replace(/,/g, ""));
    if (Number.isFinite(price) && Number.isFinite(val) && HTF_TIMEFRAMES.includes(tf)) {
      out.push({ label, price, claimedTimeframe: tf, claimedKind: kind, claimedValue: val });
    }
  }
  return out;
}

export function validateLevelCitations(
  proposalText: string,
  ctx: MarketContext,
): { citations: LevelCitation[]; anchorClaims: AnchorClaim[]; report: string } {
  const mark = ctx.snapshot.markPrice;
  // Drop implausible matches first — the regex unavoidably catches strings
  // like "R:R at TP1: 1.6" where 1.6 is a ratio, not a price. Anything more
  // than 2× away from mark or below half of mark is by construction not a
  // real entry/stop/TP candidate (the prompts already forbid 50%-away targets).
  const levels = parseProposalLevels(proposalText).filter(
    (l) => mark > 0 && l.price >= mark * 0.5 && l.price <= mark * 2,
  );
  const catalog = catalogLevels(ctx);
  const atr1h = ctx.summaries["1h"]?.atr ?? 0;

  // Semantic anchor verification: parse the model's stated <tf> <kind> <value>
  // claims and check each one against the catalog. A claim "matches" if the
  // catalog contains an entry with the same timeframe + kind whose price is
  // within tolerance of the claimed value. False claims are penalised the
  // same way as missing citations (counted as unmatched).
  const anchorClaims: AnchorClaim[] = parseAnchorClaims(proposalText).map((c) => {
    const tol = tolerance(c.claimedValue, atr1h);
    const found = catalog.some(
      (entry) =>
        entry.timeframe === c.claimedTimeframe &&
        entry.kind === c.claimedKind &&
        Math.abs(entry.price - c.claimedValue) <= tol,
    );
    return { ...c, matches: found };
  });

  const citations: LevelCitation[] = levels.map(({ label, price }) => {
    const tol = tolerance(price, atr1h);
    let best: { timeframe: HtfTimeframe; kind: string; price: number; distancePct: number } | null = null;
    let bestDist = Infinity;
    for (const c of catalog) {
      const d = Math.abs(c.price - price);
      if (d < bestDist && d <= tol) {
        bestDist = d;
        best = {
          timeframe: c.timeframe,
          kind: c.kind,
          price: c.price,
          distancePct: price > 0 ? (d / price) * 100 : 0,
        };
      }
    }
    return { label, price, nearest: best };
  });

  // Render a compact report the Observer prompt embeds verbatim. Observer
  // uses this to subtract alignment points for unmatched / mis-anchored levels.
  const lines: string[] = [];
  if (citations.length === 0) {
    lines.push("Price-proximity check: no labelled price levels found in the proposal text.");
  } else {
    lines.push("Price-proximity check (does each price sit on SOME HTF level?):");
    for (const c of citations) {
      if (c.nearest) {
        lines.push(
          `  ${c.label} ${c.price} ✓ matches ${c.nearest.timeframe} ${c.nearest.kind} ${c.nearest.price} (Δ ${c.nearest.distancePct.toFixed(2)}%)`,
        );
      } else {
        lines.push(`  ${c.label} ${c.price} ✗ NO matching HTF structural level within tolerance`);
      }
    }
  }
  if (anchorClaims.length === 0) {
    lines.push("Anchor-claim check: no '<label> @ <price> ← <tf> <kind> <value>' bullets found in HTF LEVEL ANCHORS section.");
  } else {
    lines.push("Anchor-claim check (does each cited tf+kind+value actually exist in the catalog?):");
    for (const a of anchorClaims) {
      const tag = `${a.claimedTimeframe} ${a.claimedKind} ${a.claimedValue}`;
      if (a.matches) {
        lines.push(`  ${a.label} @ ${a.price} ← ${tag} ✓ verified`);
      } else {
        lines.push(`  ${a.label} @ ${a.price} ← ${tag} ✗ NO catalog entry matches that tf+kind+value`);
      }
    }
  }
  const matched = citations.filter((c) => c.nearest).length;
  const claimsMatched = anchorClaims.filter((a) => a.matches).length;
  const summary =
    `Level Validation: ${matched}/${citations.length} prices match a known HTF level; ` +
    `${claimsMatched}/${anchorClaims.length} explicit HTF anchor claims verify against the catalog ` +
    `(tolerance ±${(atr1h * 0.4).toFixed(2)} or 0.4%).`;
  return {
    citations,
    anchorClaims,
    report: [summary, ...lines].join("\n"),
  };
}

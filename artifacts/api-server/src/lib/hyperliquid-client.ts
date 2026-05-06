import { logger } from "./logger";

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

type Meta = { universe: Array<{ name: string; szDecimals: number; maxLeverage?: number }> };
type AssetCtx = {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: [string, string] | null;
  dayBaseVlm: string;
};
type L2Book = {
  coin: string;
  time: number;
  levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>];
};

export type MarketSnapshot = {
  symbol: string;
  markPrice: number;
  oraclePrice: number;
  midPrice: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  spread: number | null;
  spreadBps: number | null;
  fundingRate: number;
  openInterest: number;
  prevDayPrice: number;
  dayVolumeUsd: number;
  changePct24h: number;
  timestamp: number;
};

const FETCH_TIMEOUT_MS = 5_000;

async function postInfo<T>(body: Record<string, unknown>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Hyperliquid Info ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as unknown;
    if (json == null || (typeof json !== "object" && !Array.isArray(json))) {
      throw new Error("Hyperliquid Info: malformed payload");
    }
    return json as T;
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new Error(`Hyperliquid Info: timeout after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown, field: string): number {
  if (typeof v !== "string" && typeof v !== "number") {
    throw new Error(`Hyperliquid payload missing/invalid field: ${field}`);
  }
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Hyperliquid payload non-finite field: ${field}`);
  }
  return n;
}

let universeCache: { symbols: Set<string>; expiresAt: number } | null = null;
const UNIVERSE_TTL_MS = 60_000;

export async function getPerpUniverse(): Promise<Set<string>> {
  if (universeCache && Date.now() < universeCache.expiresAt) {
    return universeCache.symbols;
  }
  const meta = await postInfo<Meta>({ type: "meta" });
  const symbols = new Set(meta.universe.map((u) => u.name.toUpperCase()));
  universeCache = { symbols, expiresAt: Date.now() + UNIVERSE_TTL_MS };
  return symbols;
}

export async function isValidPerpSymbol(symbol: string): Promise<boolean> {
  const universe = await getPerpUniverse();
  return universe.has(symbol.toUpperCase());
}

export async function getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  const sym = symbol.toUpperCase();

  const [metaAndCtx, book] = await Promise.all([
    postInfo<[Meta, AssetCtx[]]>({ type: "metaAndAssetCtxs" }),
    postInfo<L2Book>({ type: "l2Book", coin: sym }),
  ]);

  if (!Array.isArray(metaAndCtx) || metaAndCtx.length < 2) {
    throw new Error("Hyperliquid metaAndAssetCtxs: malformed payload");
  }
  const [meta, ctxs] = metaAndCtx;
  if (!meta?.universe || !Array.isArray(meta.universe) || !Array.isArray(ctxs)) {
    throw new Error("Hyperliquid metaAndAssetCtxs: missing universe/ctxs");
  }
  const idx = meta.universe.findIndex((u) => u?.name?.toUpperCase() === sym);
  if (idx === -1) {
    throw new Error(`Unknown perp symbol: ${symbol}`);
  }
  const ctx = ctxs[idx];
  if (!ctx) {
    throw new Error(`Hyperliquid asset ctx missing for ${symbol}`);
  }

  if (!book?.levels || !Array.isArray(book.levels)) {
    throw new Error("Hyperliquid l2Book: malformed payload");
  }
  const bids = Array.isArray(book.levels[0]) ? book.levels[0] : [];
  const asks = Array.isArray(book.levels[1]) ? book.levels[1] : [];
  const bestBid = bids[0];
  const bestAsk = asks[0];

  const bid = bestBid?.px ? parseFloat(bestBid.px) : null;
  const ask = bestAsk?.px ? parseFloat(bestAsk.px) : null;
  const bidSize = bestBid?.sz ? parseFloat(bestBid.sz) : null;
  const askSize = bestAsk?.sz ? parseFloat(bestAsk.sz) : null;
  const spread = bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : null;
  const mid = bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask) ? (ask + bid) / 2 : null;
  const spreadBps = spread != null && mid != null && mid > 0 ? (spread / mid) * 10_000 : null;

  const markPrice = num(ctx.markPx, "markPx");
  const prevDayPrice = num(ctx.prevDayPx, "prevDayPx");
  const changePct24h = prevDayPrice > 0 ? ((markPrice - prevDayPrice) / prevDayPrice) * 100 : 0;

  return {
    symbol: sym,
    markPrice,
    oraclePrice: num(ctx.oraclePx, "oraclePx"),
    midPrice: ctx.midPx != null ? num(ctx.midPx, "midPx") : mid,
    bid: bid != null && Number.isFinite(bid) ? bid : null,
    ask: ask != null && Number.isFinite(ask) ? ask : null,
    bidSize: bidSize != null && Number.isFinite(bidSize) ? bidSize : null,
    askSize: askSize != null && Number.isFinite(askSize) ? askSize : null,
    spread,
    spreadBps,
    fundingRate: num(ctx.funding, "funding"),
    openInterest: num(ctx.openInterest, "openInterest"),
    prevDayPrice,
    dayVolumeUsd: num(ctx.dayNtlVlm, "dayNtlVlm"),
    changePct24h,
    timestamp: typeof book.time === "number" ? book.time : Date.now(),
  };
}

export const CANDLE_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export function isValidCandleInterval(v: string): v is CandleInterval {
  return (CANDLE_INTERVALS as readonly string[]).includes(v);
}

export type Candle = {
  time: number; // UTC seconds (lightweight-charts format)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type RawCandle = {
  t: number; // open time ms
  T: number; // close time ms
  s: string; // symbol
  i: string; // interval
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number;
};

export async function getCandleSnapshot(
  symbol: string,
  interval: CandleInterval,
  limit: number,
): Promise<Candle[]> {
  const sym = symbol.toUpperCase();
  const clamped = Math.max(1, Math.min(1000, Math.floor(limit)));
  const endTime = Date.now();
  const startTime = endTime - clamped * INTERVAL_MS[interval];

  const raw = await postInfo<RawCandle[]>({
    type: "candleSnapshot",
    req: { coin: sym, interval, startTime, endTime },
  });

  if (!Array.isArray(raw)) {
    throw new Error("Hyperliquid candleSnapshot: malformed payload");
  }

  const bars: Candle[] = raw
    .filter((b) => b && typeof b.t === "number")
    .map((b) => ({
      time: Math.floor(b.t / 1000),
      open: num(b.o, "candle.o"),
      high: num(b.h, "candle.h"),
      low: num(b.l, "candle.l"),
      close: num(b.c, "candle.c"),
      volume: num(b.v, "candle.v"),
    }))
    .sort((a, b) => a.time - b.time);
  // Hyperliquid window queries are inclusive on both ends and can return
  // limit+1 bars. Trim to the caller's requested count for deterministic size.
  return bars.length > clamped ? bars.slice(-clamped) : bars;
}

export async function warmUniverse(): Promise<void> {
  try {
    await getPerpUniverse();
  } catch (err) {
    logger.warn({ err }, "hyperliquid universe warm-up failed");
  }
}

import * as hl from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { logger } from "./logger";
import { getMarketSnapshot } from "./hyperliquid-client";

// Asset metadata cached from the perp universe — name → { assetId, szDecimals }.
type AssetMeta = { assetId: number; szDecimals: number };
type UniverseCache = { map: Map<string, AssetMeta>; expiresAt: number };
const UNIVERSE_TTL_MS = 60_000;
// Asset IDs and szDecimals differ between mainnet and testnet, so the cache
// MUST be keyed by venue. A shared cache would let a mainnet lookup return
// stale testnet metadata (or vice versa), which would mis-route orders.
const universeCacheByVenue: Map<boolean, UniverseCache> = new Map();

async function getAssetMetaMap(useTestnet: boolean): Promise<Map<string, AssetMeta>> {
  const cached = universeCacheByVenue.get(useTestnet);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.map;
  }
  const transport = new hl.HttpTransport(useTestnet ? { isTestnet: true } : {});
  const info = new hl.InfoClient({ transport });
  const meta = await info.meta();
  const map = new Map<string, AssetMeta>();
  meta.universe.forEach((u, idx) => {
    map.set(u.name.toUpperCase(), { assetId: idx, szDecimals: u.szDecimals });
  });
  universeCacheByVenue.set(useTestnet, { map, expiresAt: Date.now() + UNIVERSE_TTL_MS });
  return map;
}

export async function lookupAsset(symbol: string, useTestnet: boolean): Promise<AssetMeta> {
  const m = await getAssetMetaMap(useTestnet);
  const meta = m.get(symbol.toUpperCase());
  if (!meta) throw new Error(`Unknown Hyperliquid perp symbol: ${symbol}`);
  return meta;
}

// Hyperliquid price formatting rules: at most 5 significant figures, AND no
// more than (6 - szDecimals) decimal places for perps. Round size to szDecimals.
export function formatHlPrice(px: number, szDecimals: number): string {
  if (!Number.isFinite(px) || px <= 0) throw new Error(`Invalid price: ${px}`);
  const maxDecimals = Math.max(0, 6 - szDecimals);
  // 5 sig figs
  const sig = parseFloat(px.toPrecision(5));
  const rounded = parseFloat(sig.toFixed(maxDecimals));
  // Strip trailing zeros for cleanliness; HL accepts canonical decimal form.
  return rounded.toString();
}

export function formatHlSize(sz: number, szDecimals: number): string {
  if (!Number.isFinite(sz) || sz <= 0) throw new Error(`Invalid size: ${sz}`);
  const rounded = parseFloat(sz.toFixed(szDecimals));
  if (rounded <= 0) throw new Error(`Size rounds to zero at szDecimals=${szDecimals}: ${sz}`);
  return rounded.toString();
}

export type BracketPlan = {
  symbol: string;
  side: "buy" | "sell"; // entry side; reduce-only legs are flipped
  entryPx: number;
  stopPx: number;
  tp1Px: number;
  tp2Px: number;
  // Total notional in USD to place at entry. Split 50/50 between TP1 and TP2.
  notionalUsd: number;
};

export type PlacedLeg = {
  kind: "entry" | "stop" | "tp1" | "tp2";
  side: "buy" | "sell";
  reduceOnly: boolean;
  orderType: "market" | "trigger";
  triggerPx: number | null;
  limitPx: number | null;
  sz: number;
  hlOrderId: string | null;
  status: "open" | "filled" | "rejected" | "error";
  filledSz: number;
  avgFillPx: number | null;
  errorMessage: string | null;
};

export type PlacementResult = {
  legs: PlacedLeg[];
  position: { symbol: string; side: "long" | "short"; sz: number; entryPx: number } | null;
};

// Build the four bracket order specs (entry market + reduce-only stop +
// 50/50 reduce-only TPs). Shared by paper and real execution paths.
function buildLegs(plan: BracketPlan, szDecimals: number): Array<{
  kind: PlacedLeg["kind"]; side: "buy" | "sell"; reduceOnly: boolean;
  orderType: "market" | "trigger"; triggerPx: number | null; limitPx: number | null; sz: number;
}> {
  const totalSz = parseFloat((plan.notionalUsd / plan.entryPx).toFixed(szDecimals));
  if (!(totalSz > 0)) {
    throw new Error(`Computed entry size is zero — increase notionalPerTradeUsd (notional=${plan.notionalUsd}, entry=${plan.entryPx}, szDec=${szDecimals})`);
  }
  // Split 50/50; ensure both halves round to a valid step.
  const halfRaw = totalSz / 2;
  const half = parseFloat(halfRaw.toFixed(szDecimals));
  if (!(half > 0)) {
    throw new Error(`Split TP size rounds to zero — totalSz=${totalSz}, szDec=${szDecimals}`);
  }
  const remainder = parseFloat((totalSz - half).toFixed(szDecimals));
  const exitSide: "buy" | "sell" = plan.side === "buy" ? "sell" : "buy";

  return [
    {
      kind: "entry", side: plan.side, reduceOnly: false,
      orderType: "market", triggerPx: null, limitPx: null, sz: totalSz,
    },
    {
      kind: "stop", side: exitSide, reduceOnly: true,
      orderType: "trigger", triggerPx: plan.stopPx, limitPx: null, sz: totalSz,
    },
    {
      kind: "tp1", side: exitSide, reduceOnly: true,
      orderType: "trigger", triggerPx: plan.tp1Px, limitPx: null, sz: half,
    },
    {
      kind: "tp2", side: exitSide, reduceOnly: true,
      orderType: "trigger", triggerPx: plan.tp2Px, limitPx: null, sz: remainder,
    },
  ];
}

// =============================================================================
// PAPER EXECUTION
// =============================================================================

export async function placeBracketPaper(plan: BracketPlan): Promise<PlacementResult> {
  // Paper still consults the live market for a realistic fill price so the
  // operator's PnL display matches "what would have happened".
  const snap = await getMarketSnapshot(plan.symbol);
  const fillPx = snap.markPrice;
  // Fake szDecimals (2) — paper just persists numerics, no exchange call.
  const legs = buildLegs(plan, 4);
  const placed: PlacedLeg[] = legs.map((l) => {
    if (l.kind === "entry") {
      return {
        ...l,
        hlOrderId: null,
        status: "filled" as const,
        filledSz: l.sz,
        avgFillPx: fillPx,
        errorMessage: null,
      };
    }
    return {
      ...l,
      hlOrderId: null,
      status: "open" as const,
      filledSz: 0,
      avgFillPx: null,
      errorMessage: null,
    };
  });
  return {
    legs: placed,
    position: {
      symbol: plan.symbol,
      side: plan.side === "buy" ? "long" : "short",
      sz: legs[0].sz,
      entryPx: fillPx,
    },
  };
}

// Paper "kill" — just mark everything closed; the route layer handles DB updates.
export async function killPaper(symbol: string): Promise<{ closedAt: Date; closedPx: number }> {
  const snap = await getMarketSnapshot(symbol);
  return { closedAt: new Date(), closedPx: snap.markPrice };
}

// =============================================================================
// REAL EXECUTION (signed via @nktkas/hyperliquid + viem)
// =============================================================================

function makeExchangeClient(privateKey: string, useTestnet: boolean) {
  const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
  const wallet = privateKeyToAccount(pk);
  const transport = new hl.HttpTransport(useTestnet ? { isTestnet: true } : {});
  const exchange = new hl.ExchangeClient({ transport, wallet });
  const info = new hl.InfoClient({ transport });
  return { exchange, info, walletAddress: wallet.address };
}

export async function placeBracketReal(
  plan: BracketPlan,
  privateKey: string,
  useTestnet: boolean,
  leverage: number,
): Promise<PlacementResult> {
  const { exchange } = makeExchangeClient(privateKey, useTestnet);
  const { assetId, szDecimals } = await lookupAsset(plan.symbol, useTestnet);

  // Apply the configured leverage on this asset BEFORE the bracket is placed.
  // Cross-margin is the safer default for a single-symbol bracket. Failure
  // here is fatal — refusing to size the trade is preferable to placing a
  // position at a leverage the operator did not approve.
  const lev = Math.max(1, Math.floor(leverage));
  try {
    await exchange.updateLeverage({ asset: assetId, isCross: true, leverage: lev });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to set leverage ${lev}x on ${plan.symbol}: ${msg}`);
  }

  const legs = buildLegs(plan, szDecimals);
  // Hyperliquid expects each order as { a, b, p, s, r, t }.
  // For market orders we send Ioc with a "slippage price" - we just nudge
  // the limit aggressively past the mark so it fills.
  const snap = await getMarketSnapshot(plan.symbol);
  const slippageMult = plan.side === "buy" ? 1.01 : 0.99;
  const marketLimitPx = formatHlPrice(snap.markPrice * slippageMult, szDecimals);

  type OrderSpec = {
    a: number; b: boolean;
    p: string; s: string; r: boolean;
    t: { limit: { tif: "Gtc" | "Ioc" | "Alo" | "FrontendMarket" } } |
       { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
  };

  const orders: OrderSpec[] = legs.map((l): OrderSpec => {
    const isLong = l.side === "buy";
    if (l.orderType === "market") {
      return {
        a: assetId, b: isLong, p: marketLimitPx,
        s: formatHlSize(l.sz, szDecimals), r: l.reduceOnly,
        t: { limit: { tif: "Ioc" } },
      };
    }
    // trigger (stop / tp)
    const triggerPx = formatHlPrice(l.triggerPx!, szDecimals);
    return {
      a: assetId, b: isLong, p: triggerPx,
      s: formatHlSize(l.sz, szDecimals), r: l.reduceOnly,
      t: { trigger: { isMarket: true, triggerPx, tpsl: l.kind === "stop" ? "sl" : "tp" } },
    };
  });

  let response;
  try {
    response = await exchange.order({ orders, grouping: "normalTpsl" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, symbol: plan.symbol }, "hyperliquid order placement failed");
    throw new Error(`Hyperliquid order failed: ${msg}`);
  }

  const statuses = response.response.data.statuses;
  if (statuses.length !== legs.length) {
    throw new Error(
      `Hyperliquid returned ${statuses.length} statuses for ${legs.length} orders`
    );
  }

  let entryFillPx: number | null = null;
  const placed: PlacedLeg[] = legs.map((l, i) => {
    const st = statuses[i];
    if (st && typeof st === "object" && "error" in st) {
      return {
        ...l, hlOrderId: null, status: "rejected" as const,
        filledSz: 0, avgFillPx: null, errorMessage: String(st.error),
      };
    }
    if (st && typeof st === "object" && "filled" in st) {
      const fillPx = parseFloat(st.filled.avgPx);
      if (l.kind === "entry") entryFillPx = fillPx;
      return {
        ...l, hlOrderId: String(st.filled.oid), status: "filled" as const,
        filledSz: parseFloat(st.filled.totalSz), avgFillPx: fillPx, errorMessage: null,
      };
    }
    if (st && typeof st === "object" && "resting" in st) {
      return {
        ...l, hlOrderId: String(st.resting.oid), status: "open" as const,
        filledSz: 0, avgFillPx: null, errorMessage: null,
      };
    }
    return {
      ...l, hlOrderId: null, status: "error" as const,
      filledSz: 0, avgFillPx: null, errorMessage: "Unknown response shape",
    };
  });

  const entryLeg = placed.find((p) => p.kind === "entry");
  const position = entryLeg && entryLeg.status === "filled" && entryFillPx != null
    ? {
        symbol: plan.symbol,
        side: (plan.side === "buy" ? "long" : "short") as "long" | "short",
        sz: entryLeg.filledSz,
        entryPx: entryFillPx,
      }
    : null;

  return { legs: placed, position };
}

export async function cancelOrdersReal(
  symbol: string,
  hlOrderIds: number[],
  privateKey: string,
  useTestnet: boolean,
): Promise<{ cancelledIds: number[]; failedIds: number[]; errors: string[] }> {
  if (hlOrderIds.length === 0) return { cancelledIds: [], failedIds: [], errors: [] };
  const { exchange } = makeExchangeClient(privateKey, useTestnet);
  const { assetId } = await lookupAsset(symbol, useTestnet);
  const cancels = hlOrderIds.map((o) => ({ a: assetId, o }));
  try {
    const resp = await exchange.cancel({ cancels });
    // The SDK's CancelSuccessResponse strips error variants — every status
    // here is the literal "success", aligned 1:1 with the input cancels.
    const statuses = resp.response.data.statuses;
    const cancelledIds: number[] = [];
    const failedIds: number[] = [];
    const errors: string[] = [];
    for (let i = 0; i < hlOrderIds.length; i++) {
      const st = statuses[i];
      if (st === "success") {
        cancelledIds.push(hlOrderIds[i]);
      } else {
        failedIds.push(hlOrderIds[i]);
        errors.push(`oid=${hlOrderIds[i]} status=${JSON.stringify(st)}`);
      }
    }
    return { cancelledIds, failedIds, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Whole batch failed — none are confirmed cancelled.
    return { cancelledIds: [], failedIds: hlOrderIds, errors: [msg] };
  }
}

// Snapshot the wallet's live state on Hyperliquid — currently-open order ids
// and current per-coin positions (signed size + entry px). Used by the
// lifecycle sync to detect SL/TP fills and natural position closes that
// happen on the exchange without going through our API.
export async function fetchAccountStateReal(
  walletAddress: string,
  useTestnet: boolean,
): Promise<{
  openOrderIds: Set<string>;
  positions: Map<string, { szi: number; entryPx: number }>;
}> {
  const transport = new hl.HttpTransport(useTestnet ? { isTestnet: true } : {});
  const info = new hl.InfoClient({ transport });
  const addr = walletAddress as `0x${string}`;
  const [orders, state] = await Promise.all([
    info.openOrders({ user: addr }),
    info.clearinghouseState({ user: addr }),
  ]);
  const openOrderIds = new Set<string>(orders.map((o) => String(o.oid)));
  const positions = new Map<string, { szi: number; entryPx: number }>();
  for (const ap of state.assetPositions) {
    const coin = ap.position.coin.toUpperCase();
    const szi = parseFloat(ap.position.szi);
    const entryPx = ap.position.entryPx ? parseFloat(ap.position.entryPx) : 0;
    if (Number.isFinite(szi)) positions.set(coin, { szi, entryPx });
  }
  return { openOrderIds, positions };
}

// Flat-close a position with a single market reduce-only order.
export async function closePositionReal(
  symbol: string,
  side: "long" | "short",
  sz: number,
  privateKey: string,
  useTestnet: boolean,
): Promise<{ closedAt: Date; closedPx: number; hlOrderId: string | null; confirmed: boolean }> {
  const { exchange } = makeExchangeClient(privateKey, useTestnet);
  const { assetId, szDecimals } = await lookupAsset(symbol, useTestnet);
  const snap = await getMarketSnapshot(symbol);
  const exitSide: "buy" | "sell" = side === "long" ? "sell" : "buy";
  const slippageMult = exitSide === "buy" ? 1.01 : 0.99;
  const limitPx = formatHlPrice(snap.markPrice * slippageMult, szDecimals);

  const resp = await exchange.order({
    orders: [{
      a: assetId,
      b: exitSide === "buy",
      p: limitPx,
      s: formatHlSize(sz, szDecimals),
      r: true,
      t: { limit: { tif: "Ioc" } },
    }],
    grouping: "na",
  });
  const st = resp.response.data.statuses[0];
  let hlOrderId: string | null = null;
  let closedPx = snap.markPrice;
  let confirmed = false;
  // OrderSuccessResponse strips error variants — only filled/resting
  // (object) or "waitingForFill"/"waitingForTrigger" (string) remain.
  // We only treat the close as CONFIRMED when the IOC actually filled —
  // a resting/waiting outcome means the position is still on the book.
  if (st && typeof st === "object" && "filled" in st) {
    hlOrderId = String(st.filled.oid);
    closedPx = parseFloat(st.filled.avgPx);
    confirmed = true;
  } else if (st && typeof st === "object" && "resting" in st) {
    hlOrderId = String(st.resting.oid);
  }
  return { closedAt: new Date(), closedPx, hlOrderId, confirmed };
}

import { db, missions, executionConfig, executionOrders, executionPositions, reasoningPackets } from "@workspace/db";
import { eq, and, ne, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { decryptSecret } from "./encryption";
import { tryAppendLedgerEntry, LEDGER_ACTIONS, type LedgerAction } from "./ledger";
import {
  placeBracketPaper, placeBracketReal, killPaper,
  cancelOrdersReal, closePositionReal, fetchAccountStateReal,
  type BracketPlan, type PlacementResult,
} from "./hyperliquid-executor";
import { getMarketSnapshot } from "./hyperliquid-client";

export class ExecutionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ExecutionError";
    this.status = status;
  }
}

// Strip a numeric value out of a free-form trade-plan string. Handles
// "76,000", "76,000.5", "76,000–76,120" (range — uses the midpoint),
// "76000 USD", and graceful fallback when the value is unparseable.
export function parsePlanNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  // Keep digits, separators, range glyphs, AND the literal word "to" so the
  // range regex below can detect "lo to hi". Strip everything else.
  const cleaned = s.replace(/,/g, "").replace(/[^\dA-Za-z.\-–~ ]/g, " ")
    .replace(/[A-Za-z]+/g, (w) => w.toLowerCase() === "to" ? "to" : " ")
    .replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  // Range: "lo to hi" / "lo - hi" / "lo – hi" / "lo ~ hi" — return midpoint.
  const range = cleaned.match(/(-?\d+(?:\.\d+)?)\s*(?:to|[-–~])\s*(-?\d+(?:\.\d+)?)/i);
  if (range) {
    const a = parseFloat(range[1]); const b = parseFloat(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
  }
  const single = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (single) {
    const n = parseFloat(single[0]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Parse the Queen's free-form sizing hint into a USD notional.
// Examples handled:
//   "$500"           -> 500
//   "500 USD"        -> 500
//   "2%"             -> maxNotionalUsd * 0.02
//   "2% of account"  -> maxNotionalUsd * 0.02
//   "1R"             -> fallback
//   ""/null/garbage  -> fallback
// The fallback is `defaultNotional` (operator-set per-trade default).
// The caller is still responsible for clamping the result to [10, cap].
export function parseSizingHint(hint: string, defaultNotional: number, maxNotionalUsd: number): number {
  if (!hint || typeof hint !== "string") return defaultNotional;
  const s = hint.trim();
  if (!s) return defaultNotional;
  const numMatch = s.match(/-?\d+(?:[.,]\d+)?/);
  if (!numMatch) return defaultNotional;
  const n = parseFloat(numMatch[0].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return defaultNotional;
  if (s.includes("%")) return Math.round(maxNotionalUsd * (n / 100));
  // "1R", "2R" etc. — ambiguous without account/risk values, fall back.
  if (/r\b/i.test(s) && !/\$|usd/i.test(s)) return defaultNotional;
  return n;
}

export type StoredFinalVerdict = {
  stance: "CONFIRM" | "COUNTER" | "STAND_DOWN";
  tradePlan: {
    symbol: string;
    bias: "LONG" | "SHORT" | "FLAT";
    entry: string; stop: string; tp1: string; tp2: string;
    sizing: string; rr: string;
  };
  selectedTimeframe?: string;
  // … other fields are present but execution doesn't need them.
};

export async function getOrCreateConfig() {
  const existing = await db.query.executionConfig.findFirst({
    where: eq(executionConfig.id, 1),
  });
  if (existing) return existing;
  const [created] = await db.insert(executionConfig).values({ id: 1 }).returning();
  return created;
}

// Public-safe view of the config (no private key).
export function redactConfig(cfg: typeof executionConfig.$inferSelect) {
  return {
    walletAddress: cfg.walletAddress,
    hasPrivateKey: !!cfg.encryptedPrivateKey,
    useTestnet: cfg.useTestnet,
    paperMode: cfg.paperMode,
    notionalPerTradeUsd: cfg.notionalPerTradeUsd,
    maxNotionalUsd: cfg.maxNotionalUsd,
    maxConcurrentTrades: cfg.maxConcurrentTrades,
    defaultLeverage: cfg.defaultLeverage,
    updatedAt: cfg.updatedAt,
  };
}

// Audit-trail row written into reasoningPackets so the existing audit UI
// surfaces execution events alongside the debate transcript. agentRole is
// "executor" (already used by the deliverable path) and verdict carries the
// event kind (SUBMIT / FILL / CANCEL / KILL / ERROR).
//
// Every audit call ALSO appends a tamper-evident ledger entry (Task #37).
// The ledger captures the mission objective, the Queen Final Verdict
// reference, the trade plan snapshot, and the action-specific payload —
// chained with SHA-256 so any post-hoc edit is detectable. Ledger writes
// are best-effort: a disk failure here never breaks the execution path.
async function audit(
  missionId: number,
  cycle: number,
  kind: string,
  summary: string,
  payload?: unknown,
  source: string = "executor",
) {
  await db.insert(reasoningPackets).values({
    missionId, cycle, agentRole: "executor",
    reasoning: `[execution.${kind}] ${summary}`,
    proposal: payload ? JSON.stringify(payload, null, 2) : null,
    verdict: kind.toUpperCase(),
  });

  // Defensive: normalise to lowercase so a future caller passing "SUBMIT"
  // does not silently get reclassified as "error" in the ledger.
  const k = kind.toLowerCase();
  const action: LedgerAction = (LEDGER_ACTIONS as readonly string[]).includes(k)
    ? (k as LedgerAction)
    : "error";
  let m: typeof missions.$inferSelect | undefined;
  try {
    m = await db.query.missions.findFirst({ where: eq(missions.id, missionId) });
  } catch (err) {
    logger.warn({ err, missionId }, "ledger: mission lookup failed");
  }
  const verdict = (m?.finalVerdictJson ?? null) as StoredFinalVerdict | null;
  // Resolve the most recent Queen FINAL_VERDICT reasoningPacket for this
  // mission so the ledger entry carries an explicit packet ID — strict
  // forensic linkage from the trade back to the exact Queen verdict that
  // authorised it. Best-effort: a lookup failure does not break audit().
  let verdictPacketId: number | null = null;
  try {
    // Strict scoping: only the Queen's FINAL_VERDICT packets count as the
    // authorising verdict for an execution. Plain agentRole='queen' would
    // also match preliminary/debate packets and could drift the linkage.
    const row = await db.query.reasoningPackets.findFirst({
      where: and(
        eq(reasoningPackets.missionId, missionId),
        eq(reasoningPackets.agentRole, "queen"),
        eq(reasoningPackets.verdict, "FINAL_VERDICT"),
      ),
      orderBy: (t, { desc }) => [desc(t.id)],
      columns: { id: true },
    });
    verdictPacketId = row?.id ?? null;
  } catch (err) {
    logger.warn({ err, missionId }, "ledger: verdict packet lookup failed");
  }
  await tryAppendLedgerEntry({
    missionId,
    action,
    source,
    missionObjective: m?.primeObjective ?? null,
    verdictRef: verdict
      ? {
          stance: verdict.stance,
          symbol: verdict.tradePlan?.symbol ?? null,
          bias: verdict.tradePlan?.bias ?? null,
          cycle,
          packetId: verdictPacketId,
        }
      : null,
    tradePlan: verdict?.tradePlan ?? null,
    payload: { summary, data: payload ?? null },
  });
}

export async function executeMission(missionId: number): Promise<{
  paper: boolean;
  legs: PlacementResult["legs"];
  position: PlacementResult["position"];
}> {
  const mission = await db.query.missions.findFirst({ where: eq(missions.id, missionId) });
  if (!mission) throw new ExecutionError("Mission not found", 404);

  // Atomic single-flight claim. Without this, two concurrent /execute
  // calls (double-click, network retry, parallel operators) both pass
  // the executable-states check and both submit live brackets before
  // status flips to "executing". The claim is one conditional UPDATE
  // that:
  //   - matches only when status ∈ {awaiting_queen, locked}, AND
  //   - matches only when currentPhase is either NULL or does NOT
  //     already start with "execute-claim:" (rejecting concurrent
  //     callers that already claimed).
  // It atomically swaps currentPhase to `execute-claim:<nonce>`. The
  // loser of the race gets zero updated rows and we map that to 409.
  // The previously-set currentPhase is captured in the SAME query via
  // a CTE so we know what to restore on failure (Postgres RETURNING
  // exposes only the new row, not the old).
  const claimNonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const claimRes = await db.execute(sql`
    WITH prev AS (
      SELECT id, current_phase AS prev_phase
      FROM missions
      WHERE id = ${missionId}
    ),
    upd AS (
      UPDATE missions
      SET current_phase = ${`execute-claim:${claimNonce}`},
          updated_at = NOW()
      WHERE id = ${missionId}
        AND status IN ('awaiting_queen', 'locked')
        AND (current_phase IS NULL OR current_phase NOT LIKE 'execute-claim:%')
      RETURNING id
    )
    SELECT prev.prev_phase AS prev_phase,
           (SELECT id FROM upd) AS claimed_id
    FROM prev
  `);
  // Drizzle returns rows under .rows for raw queries.
  const row = (claimRes as unknown as { rows: { prev_phase: string | null; claimed_id: number | null }[] }).rows[0];
  if (!row || row.claimed_id == null) {
    // Either the mission isn't in an executable status, or another
    // /execute call already owns the claim. Both surface as 409.
    throw new ExecutionError(
      `Mission status "${mission.status}" is not executable, or another execution is already in flight.`,
      409,
    );
  }
  const prevPhase: string | null = row.prev_phase;
  // Helper to release the claim on every failure path so the mission
  // can be retried instead of being permanently stuck mid-claim. Only
  // releases if the row STILL carries our nonce (i.e. nobody else has
  // moved it on, e.g. via successful execution flipping it to "live").
  const releaseClaim = async () => {
    await db.update(missions).set({
      currentPhase: prevPhase, updatedAt: new Date(),
    }).where(and(
      eq(missions.id, missionId),
      eq(missions.currentPhase, `execute-claim:${claimNonce}`),
    ));
  };

  // From here on, ANY failure path must release the single-flight claim
  // so the operator can retry. We wrap the rest of the body in try/catch
  // and only commit the claim (status="executing") inside the persistence
  // transaction at the end.
  try {

  const verdict = mission.finalVerdictJson as StoredFinalVerdict | null;
  if (!verdict) {
    throw new ExecutionError("Mission has no Queen Final Verdict to execute. Run the debate first.", 400);
  }
  if (verdict.stance === "STAND_DOWN") {
    throw new ExecutionError("Queen verdict is STAND_DOWN — execution is disabled.", 400);
  }
  if (verdict.tradePlan.bias === "FLAT") {
    throw new ExecutionError("Trade plan bias is FLAT — nothing to execute.", 400);
  }

  const symbol = verdict.tradePlan.symbol.toUpperCase();
  const entry = parsePlanNumber(verdict.tradePlan.entry);
  const stop = parsePlanNumber(verdict.tradePlan.stop);
  const tp1 = parsePlanNumber(verdict.tradePlan.tp1);
  const tp2 = parsePlanNumber(verdict.tradePlan.tp2);
  if (!entry || !stop || !tp1 || !tp2) {
    throw new ExecutionError(
      `Trade plan has unparseable numerics (entry=${entry} stop=${stop} tp1=${tp1} tp2=${tp2})`,
      400,
    );
  }

  const cfg = await getOrCreateConfig();

  // --- Translate verdict sizing into a notional USD figure ---
  // The Queen's tradePlan.sizing is a free-form hint (e.g. "$500", "2%",
  // "1R"). "%" => percentage of maxNotionalUsd; bare number => USD;
  // unparseable => fallback to cfg.notionalPerTradeUsd.
  // Risk-cap policy: the derived notional MUST NOT silently clamp down to
  // the cap — that would let an oversized verdict masquerade as a sized
  // trade. Instead we reject loudly with a 400 so the operator can either
  // raise the cap or override the verdict.
  const sizingHint = verdict.tradePlan.sizing ?? "";
  const desiredNotional = parseSizingHint(sizingHint, cfg.notionalPerTradeUsd, cfg.maxNotionalUsd);
  if (desiredNotional > cfg.maxNotionalUsd) {
    throw new ExecutionError(
      `Verdict sizing "${sizingHint}" → $${desiredNotional} exceeds maxNotionalUsd cap ($${cfg.maxNotionalUsd}). Raise the cap on EXECUTION.CONTROL or revise the trade plan.`,
      400,
    );
  }
  if (desiredNotional < 10) {
    throw new ExecutionError(
      `Verdict sizing "${sizingHint}" → $${desiredNotional} is below the $10 minimum notional.`,
      400,
    );
  }
  const notionalUsd = desiredNotional;

  // --- Risk caps (apply to BOTH paper and real so behavior is symmetric) ---
  if (cfg.notionalPerTradeUsd > cfg.maxNotionalUsd) {
    throw new ExecutionError(
      `notionalPerTradeUsd (${cfg.notionalPerTradeUsd}) exceeds maxNotionalUsd cap (${cfg.maxNotionalUsd})`,
      400,
    );
  }
  const openCount = await db.$count(
    executionPositions,
    eq(executionPositions.status, "open"),
  );
  if (openCount >= cfg.maxConcurrentTrades) {
    throw new ExecutionError(
      `Max concurrent trades cap reached (${openCount}/${cfg.maxConcurrentTrades}). Close an open position before executing another.`,
      400,
    );
  }

  // --- Real-mode credential check ---
  let privateKey: string | null = null;
  if (!cfg.paperMode) {
    if (!cfg.encryptedPrivateKey || !cfg.walletAddress) {
      throw new ExecutionError(
        "Real execution mode is on but no Hyperliquid wallet is configured. Set credentials on the EXECUTION page or switch to paper mode.",
        400,
      );
    }
    try {
      privateKey = decryptSecret(cfg.encryptedPrivateKey);
    } catch (err) {
      logger.error({ err }, "decrypt private key failed");
      throw new ExecutionError("Failed to decrypt stored wallet key.", 500);
    }
  }

  const side: "buy" | "sell" = verdict.tradePlan.bias === "LONG" ? "buy" : "sell";
  const plan: BracketPlan = {
    symbol, side,
    entryPx: entry, stopPx: stop, tp1Px: tp1, tp2Px: tp2,
    notionalUsd,
  };

  await audit(missionId, mission.cycleCount ?? 0, "submit",
    `${cfg.paperMode ? "PAPER" : "LIVE"} ${plan.side.toUpperCase()} ${symbol} notional=$${plan.notionalUsd} (sizing="${sizingHint}", cap=$${cfg.maxNotionalUsd})`,
    { plan, sizingHint, derivedNotional: desiredNotional, notionalUsdUsed: notionalUsd, maxNotionalUsd: cfg.maxNotionalUsd },
  );

  // --- Place ---
  let result: PlacementResult;
  try {
    if (cfg.paperMode) {
      result = await placeBracketPaper(plan);
    } else {
      result = await placeBracketReal(plan, privateKey!, cfg.useTestnet, cfg.defaultLeverage);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit(missionId, mission.cycleCount ?? 0, "error", `Placement failed: ${msg}`);
    throw new ExecutionError(msg, 502);
  }

  // --- Bracket-integrity validation ---
  // A successful API response from Hyperliquid does NOT mean every leg was
  // accepted — individual legs can come back "rejected"/"error". Two cases
  // must be treated as failure, NOT silently persisted with status=executing:
  //   1. Entry leg itself rejected/errored — there's no trade to manage.
  //   2. Entry filled but ANY protective leg (stop/tp1/tp2) is not in
  //      {open, filled} — the position would be live without full
  //      protection, which is exactly what the bracket exists to prevent.
  // Case 2 triggers emergency remediation: cancel any accepted protective
  // legs and force-close the entry on the same venue, then surface a 502.
  const entryLeg = result.legs.find((l) => l.kind === "entry");
  const protectiveLegs = result.legs.filter((l) => l.kind === "stop" || l.kind === "tp1" || l.kind === "tp2");
  const ACCEPTED = new Set(["open", "filled"]);
  const failedProtective = protectiveLegs.filter((l) => !ACCEPTED.has(l.status));

  if (!entryLeg || !ACCEPTED.has(entryLeg.status)) {
    const reason = entryLeg?.errorMessage ?? entryLeg?.status ?? "missing entry leg";
    // If somehow protective legs landed without an entry, cancel them so
    // they don't sit on the book unattached.
    const orphans = protectiveLegs.filter((l) => l.hlOrderId && l.status === "open");
    if (!cfg.paperMode && orphans.length > 0 && privateKey) {
      const ids = orphans.map((l) => parseInt(l.hlOrderId!)).filter(Number.isFinite);
      if (ids.length > 0) {
        try { await cancelOrdersReal(plan.symbol, ids, privateKey, cfg.useTestnet); }
        catch (e) { logger.error({ err: e }, "orphan cancel after entry failure failed"); }
      }
    }
    await audit(missionId, mission.cycleCount ?? 0, "error",
      `Entry leg not accepted by exchange: ${reason}. Mission NOT marked executing.`,
      { result },
    );
    throw new ExecutionError(`Entry leg rejected by exchange: ${reason}`, 502);
  }

  if (failedProtective.length > 0) {
    const summary = failedProtective.map((l) => `${l.kind}=${l.status}${l.errorMessage ? ` (${l.errorMessage})` : ""}`).join(", ");
    if (!cfg.paperMode && privateKey) {
      // Cancel any protective legs that DID land so we don't leave one-sided
      // protection on the book.
      const acceptedProtective = protectiveLegs.filter((l) => l.hlOrderId && l.status === "open");
      const ids = acceptedProtective.map((l) => parseInt(l.hlOrderId!)).filter(Number.isFinite);
      if (ids.length > 0) {
        try { await cancelOrdersReal(plan.symbol, ids, privateKey, cfg.useTestnet); }
        catch (e) { logger.error({ err: e }, "protective cancel after partial bracket failure failed"); }
      }
      // If the entry filled, force-close it — we will NOT carry a live
      // position without its bracket protection.
      if (result.position) {
        try {
          await closePositionReal(
            result.position.symbol,
            result.position.side,
            result.position.sz,
            privateKey,
            cfg.useTestnet,
          );
        } catch (e) {
          logger.error({ err: e }, "emergency close after partial bracket failure failed");
        }
      }
    }
    await audit(missionId, mission.cycleCount ?? 0, "error",
      `Bracket protection incomplete (${summary}). Remediated and aborted; mission NOT marked executing.`,
      { result },
    );
    throw new ExecutionError(
      `Bracket protection incomplete: ${summary}. Cancelled accepted legs and force-closed entry. Verify position on Hyperliquid before retrying.`,
      502,
    );
  }

  // --- Persist orders + position ---
  await db.transaction(async (tx) => {
    for (const leg of result.legs) {
      await tx.insert(executionOrders).values({
        missionId, kind: leg.kind, side: leg.side,
        reduceOnly: leg.reduceOnly, orderType: leg.orderType,
        triggerPx: leg.triggerPx, limitPx: leg.limitPx, sz: leg.sz,
        hlOrderId: leg.hlOrderId, status: leg.status,
        filledSz: leg.filledSz, avgFillPx: leg.avgFillPx,
        errorMessage: leg.errorMessage,
        paper: cfg.paperMode,
        useTestnet: cfg.useTestnet,
        walletAddress: cfg.paperMode ? null : cfg.walletAddress,
      });
    }
    if (result.position) {
      await tx.insert(executionPositions).values({
        missionId, symbol: result.position.symbol, side: result.position.side,
        sz: result.position.sz, entryPx: result.position.entryPx,
        paper: cfg.paperMode,
        useTestnet: cfg.useTestnet,
        walletAddress: cfg.paperMode ? null : cfg.walletAddress,
        notionalUsdUsed: notionalUsd,
      });
    }
    await tx.update(missions).set({
      status: "executing",
      currentPhase: "live",
      updatedAt: new Date(),
    }).where(eq(missions.id, missionId));
  });

  await audit(missionId, mission.cycleCount ?? 0, "fill",
    `Entry ${result.position ? "filled" : "submitted"}; ${result.legs.length} legs persisted`,
    { result },
  );

  return { paper: cfg.paperMode, legs: result.legs, position: result.position };
  } catch (err) {
    // Forensic completeness: every operator-facing failure during execute()
    // — including early precondition throws (no verdict / STAND_DOWN / FLAT
    // / sizing caps / decrypt) that happen BEFORE the first audit call —
    // produces an explicit ledger `error` entry so the chain reflects what
    // the operator saw. Best-effort: a failed audit must not mask the
    // original error.
    try {
      const msg = err instanceof Error ? err.message : String(err);
      await audit(missionId, mission.cycleCount ?? 0, "error",
        `Execute aborted: ${msg}`);
    } catch (e) { logger.error({ err: e }, "execute error-audit failed"); }
    // Release the single-flight claim so the operator can retry.
    // The persistence transaction overwrites currentPhase to "live" on
    // success, so this only runs on a true failure path.
    try { await releaseClaim(); } catch (e) { logger.error({ err: e }, "claim release failed"); }
    throw err;
  }
}

export async function killExecution(missionId: number): Promise<{
  cancelled: number; closed: boolean; closedPx: number | null; errors: string[];
}> {
  const cfg = await getOrCreateConfig();
  // Resolve mission cycle up front so all KILL audit packets attribute to
  // the same cycle as the rest of the mission (instead of cycle=0).
  const missionRow = await db.query.missions.findFirst({ where: eq(missions.id, missionId) });
  const cycle = missionRow?.cycleCount ?? 0;
  // Include rows in BOTH "open" AND "error" status. A previous KILL attempt
  // that could not confirm the cancel with Hyperliquid leaves the row in
  // "error" with hlOrderId still set — those orders may still be live on
  // the exchange and MUST be retried by subsequent KILL calls. If we only
  // selected "open", a second KILL would be a no-op and the mission could
  // be stranded in `executing` forever.
  const allOrders = await db.query.executionOrders.findMany({
    where: and(
      eq(executionOrders.missionId, missionId),
      inArray(executionOrders.status, ["open", "error"]),
    ),
  });
  const openOrders = allOrders.filter(
    (o) => o.status === "open" || (o.status === "error" && o.hlOrderId),
  );
  const position = await db.query.executionPositions.findFirst({
    where: and(
      eq(executionPositions.missionId, missionId),
      eq(executionPositions.status, "open"),
    ),
  });

  if (openOrders.length === 0 && !position) {
    return { cancelled: 0, closed: false, closedPx: null, errors: [] };
  }

  let cancelled = 0;
  let closed = false;
  let closedPx: number | null = null;
  const errors: string[] = [];

  // CRITICAL: derive execution mode from each row's `paper` flag, NOT from
  // the global cfg.paperMode (which could have been toggled after a real
  // trade was placed). Real rows always go through the real exchange.
  const realOrders = openOrders.filter((o) => !o.paper && o.hlOrderId);
  const paperOrders = openOrders.filter((o) => o.paper);
  const hasRealRows = realOrders.length > 0 || (position && !position.paper);

  // Resolve symbol: prefer the position row, else look at any open order's
  // mission verdict (orders share a single bracket symbol per mission).
  let symbol = position?.symbol;
  if (!symbol) {
    const m = await db.query.missions.findFirst({ where: eq(missions.id, missionId) });
    const v = m?.finalVerdictJson as StoredFinalVerdict | null;
    symbol = v?.tradePlan?.symbol?.toUpperCase();
  }

  // Decrypt the wallet key only when real rows exist. If the row is real
  // but the operator has cleared the key, surface a hard error — silent
  // success would leave live exposure unmanaged.
  let pk: string | null = null;
  if (hasRealRows) {
    if (!cfg.encryptedPrivateKey) {
      await audit(missionId, cycle, "error",
        "KILL aborted: live real-mode rows but wallet key is not configured", null, "kill");
      throw new ExecutionError(
        "Cannot KILL: this mission has live Hyperliquid positions/orders but the wallet key is no longer configured. Restore the key on the EXECUTION page first.",
        409,
      );
    }
    try { pk = decryptSecret(cfg.encryptedPrivateKey); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`decrypt failed: ${msg}`);
      await audit(missionId, cycle, "error",
        `KILL aborted: failed to decrypt wallet key — ${msg}`, null, "kill");
      throw new ExecutionError("Failed to decrypt wallet key for KILL", 500);
    }
  }

  // Cancel real resting orders. We only flip a row to `cancelled` when HL
  // confirmed that specific order ID — failed/unknown rows stay open with
  // status="error" so the operator can see them and retry KILL. Each row
  // carries its own placement-time `useTestnet` so kills route to the same
  // venue the order was placed against (resilient to config toggles).
  const confirmedCancelRowIds: number[] = paperOrders.map((o) => o.id);
  const failedCancelRowIds: number[] = [];
  // Audit paper-mode cancels distinctly from the aggregate KILL packet so
  // the submit/fill/cancel/kill/error trail is symmetric across modes.
  if (paperOrders.length > 0) {
    await audit(missionId, cycle, "cancel",
      `Cancel (paper): ${paperOrders.length} order(s) cancelled locally`,
      { venue: "paper", cancelledRowIds: paperOrders.map((o) => o.id) },
    );
  }
  if (realOrders.length > 0 && pk && symbol) {
    const byVenue = new Map<boolean, typeof realOrders>();
    for (const o of realOrders) {
      const arr = byVenue.get(o.useTestnet) ?? [];
      arr.push(o);
      byVenue.set(o.useTestnet, arr);
    }
    for (const [venue, group] of byVenue) {
      const oidToRowId = new Map<number, number>();
      const ids: number[] = [];
      for (const o of group) {
        const oid = parseInt(o.hlOrderId!);
        if (Number.isFinite(oid)) {
          ids.push(oid);
          oidToRowId.set(oid, o.id);
        } else {
          failedCancelRowIds.push(o.id);
        }
      }
      if (ids.length === 0) continue;
      const r = await cancelOrdersReal(symbol, ids, pk, venue);
      for (const oid of r.cancelledIds) {
        const rowId = oidToRowId.get(oid);
        if (rowId != null) confirmedCancelRowIds.push(rowId);
      }
      for (const oid of r.failedIds) {
        const rowId = oidToRowId.get(oid);
        if (rowId != null) failedCancelRowIds.push(rowId);
      }
      errors.push(...r.errors);
      await audit(missionId, cycle, "cancel",
        `Cancel (${venue ? "testnet" : "mainnet"}): ${r.cancelledIds.length}/${ids.length} confirmed by Hyperliquid`,
        { venue: venue ? "testnet" : "mainnet", confirmedOids: r.cancelledIds, failedOids: r.failedIds, errors: r.errors },
      );
    }
  } else if (realOrders.length > 0) {
    for (const o of realOrders) failedCancelRowIds.push(o.id);
  }
  cancelled = confirmedCancelRowIds.length;

  // Close position. For real rows we only mark `closed` when Hyperliquid
  // confirmed the IOC fill — a resting/waiting outcome (or any thrown
  // error) means exposure may still be live, so we leave the row OPEN
  // and surface the uncertainty to the operator.
  if (position) {
    if (!position.paper && pk) {
      try {
        const r = await closePositionReal(
          position.symbol,
          position.side as "long" | "short",
          position.sz, pk, position.useTestnet,
        );
        if (r.confirmed) {
          closed = true; closedPx = r.closedPx;
        } else {
          errors.push(
            `close position not confirmed by Hyperliquid (oid=${r.hlOrderId ?? "n/a"}) — position may still be live`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`close position failed: ${msg}`);
        // Do NOT mark closed — leave the row open so the operator can retry.
      }
    } else if (position.paper) {
      const r = await killPaper(position.symbol);
      closed = true; closedPx = r.closedPx;
    }
  }

  // --- Persist new states ---
  await db.transaction(async (tx) => {
    if (confirmedCancelRowIds.length > 0) {
      await tx.update(executionOrders).set({
        status: "cancelled",
        updatedAt: new Date(),
      }).where(inArray(executionOrders.id, confirmedCancelRowIds));
    }
    if (failedCancelRowIds.length > 0) {
      // Surface the failure on the row itself; do NOT mark cancelled.
      await tx.update(executionOrders).set({
        status: "error",
        errorMessage: "Cancel not confirmed by Hyperliquid — order may still be live",
        updatedAt: new Date(),
      }).where(inArray(executionOrders.id, failedCancelRowIds));
    }
    if (position && closed) {
      await tx.update(executionPositions).set({
        status: "killed",
        closedAt: new Date(),
        lastSyncedAt: new Date(),
      }).where(eq(executionPositions.id, position.id));
    }
    // Mission only completes when ALL live exposure is provably gone:
    //   - position is closed (or never existed), AND
    //   - no order rows are left in an uncertain state (no failed cancels).
    const positionResolved = !position || closed;
    const ordersResolved = failedCancelRowIds.length === 0;
    if (positionResolved && ordersResolved) {
      await tx.update(missions).set({
        status: "completed",
        currentPhase: null,
        updatedAt: new Date(),
      }).where(eq(missions.id, missionId));
    }
  });

  await audit(missionId, cycle, "kill",
    `KILL: cancelled ${cancelled} rests; ${closed ? `closed @ ${closedPx}` : "no position to close"}`,
    { errors },
  );

  return { cancelled, closed, closedPx, errors };
}

// Reconcile our DB state with what Hyperliquid actually shows for the wallet:
//   - any executionOrder row whose hlOrderId is no longer in openOrders is
//     considered filled (SL/TP triggered on-exchange);
//   - if the wallet's signed position size for the symbol is 0 (or the coin
//     is no longer present in assetPositions) and we still have an open row
//     for it, mark the position closed at the current mark.
// This is a best-effort lazy sync called on every execution snapshot read,
// so the UI naturally drives reconciliation when the operator is watching.
// Paper rows are skipped — they have no exchange counterpart.
export async function syncMissionExecutionFromExchange(missionId: number): Promise<void> {
  // Read-only sync — uses HL info endpoints (openOrders +
  // clearinghouseState). Only a wallet address is needed; the private key
  // is NOT required, so monitoring continues even if the operator has
  // cleared the key. We use the wallet address persisted on each row
  // (pinned at placement) — NOT the current global cfg.walletAddress —
  // so credential rotation cannot make us read the wrong account.
  const cfg = await getOrCreateConfig();
  const missionRow = await db.query.missions.findFirst({ where: eq(missions.id, missionId) });
  const cycle = missionRow?.cycleCount ?? 0;

  const openOrders = await db.query.executionOrders.findMany({
    where: and(
      eq(executionOrders.missionId, missionId),
      eq(executionOrders.status, "open"),
    ),
  });
  const position = await db.query.executionPositions.findFirst({
    where: and(
      eq(executionPositions.missionId, missionId),
      eq(executionPositions.status, "open"),
    ),
  });
  const realOrders = openOrders.filter((o) => !o.paper);
  const hasRealPosition = position && !position.paper;
  if (realOrders.length === 0 && !hasRealPosition) return;

  // Group rows by (walletAddress, useTestnet) — the venue+account they
  // were placed against. Fall back to current cfg.walletAddress only when
  // a row pre-dates the per-row column (legacy null).
  type Key = string;
  const keyOf = (wallet: string, venue: boolean): Key => `${wallet.toLowerCase()}|${venue ? "t" : "m"}`;
  const accounts = new Map<Key, { wallet: string; venue: boolean }>();
  const rowKey = (wallet: string | null, venue: boolean): Key | null => {
    const w = wallet ?? cfg.walletAddress;
    if (!w) return null;
    const k = keyOf(w, venue);
    if (!accounts.has(k)) accounts.set(k, { wallet: w, venue });
    return k;
  };
  const orderKeys = new Map<number, Key>();
  for (const o of realOrders) {
    const k = rowKey(o.walletAddress, o.useTestnet);
    if (k) orderKeys.set(o.id, k);
  }
  let positionKey: Key | null = null;
  if (hasRealPosition) {
    positionKey = rowKey(position!.walletAddress, position!.useTestnet);
  }
  if (accounts.size === 0) return; // nothing we can reconcile

  const snapsByKey = new Map<Key, {
    openOrderIds: Set<string>;
    positions: Map<string, { szi: number; entryPx: number }>;
  }>();
  for (const [k, { wallet, venue }] of accounts) {
    try {
      snapsByKey.set(k, await fetchAccountStateReal(wallet, venue));
    } catch (err) {
      logger.warn({ err, missionId, wallet, venue }, "exchange-state sync failed");
    }
  }

  const filledIds: number[] = [];
  for (const o of realOrders) {
    if (!o.hlOrderId) continue;
    const k = orderKeys.get(o.id);
    if (!k) continue;
    const snap = snapsByKey.get(k);
    if (!snap) continue;
    if (!snap.openOrderIds.has(o.hlOrderId)) filledIds.push(o.id);
  }
  if (filledIds.length > 0) {
    await db.update(executionOrders).set({
      status: "filled",
      updatedAt: new Date(),
    }).where(inArray(executionOrders.id, filledIds));
    await audit(missionId, cycle, "fill",
      `Exchange-side fill detected for ${filledIds.length} order(s) (SL/TP triggered)`,
      { orderIds: filledIds },
    );
  }

  if (hasRealPosition && positionKey) {
    const snap = snapsByKey.get(positionKey);
    if (!snap) return;
    const live = snap.positions.get(position!.symbol.toUpperCase());
    const liveSz = live ? Math.abs(live.szi) : 0;
    if (liveSz === 0) {
      let closedPx = position.entryPx;
      try { closedPx = (await getMarketSnapshot(position.symbol)).markPrice; }
      catch { /* keep entry as fallback */ }
      const dir = position.side === "long" ? 1 : -1;
      const realized = (closedPx - position.entryPx) * position.sz * dir;
      await db.update(executionPositions).set({
        status: "closed",
        closedAt: new Date(),
        lastSyncedAt: new Date(),
        unrealizedPnlUsd: realized,
      }).where(eq(executionPositions.id, position.id));
      // If no exposure remains anywhere, complete the mission.
      const remaining = await db.$count(
        executionPositions,
        and(
          eq(executionPositions.missionId, missionId),
          eq(executionPositions.status, "open"),
        )!,
      );
      if (remaining === 0) {
        await db.update(missions).set({
          status: "completed", currentPhase: null, updatedAt: new Date(),
        }).where(eq(missions.id, missionId));
      }
      await audit(missionId, cycle, "close",
        `Position closed on exchange @ ${closedPx} (realized ${realized.toFixed(2)} USD)`,
        { closedPx, realized },
      );
    }
  }
}

// Paper lifecycle simulator. Real bracket legs are filled by Hyperliquid's
// trigger engine; paper legs have no exchange counterpart, so we evaluate
// them ourselves against the live mark on every snapshot read so paper
// missions follow the same submit→fill→close lifecycle as real ones.
//
// Trigger semantics (matches the real exchange's trigger-by-mark behaviour):
//   LONG  position: stop fires when mark <= stopPx; tp fires when mark >= tpPx
//   SHORT position: stop fires when mark >= stopPx; tp fires when mark <= tpPx
// Stop hit closes the entire remaining position at the stop price and
// cancels any still-open TP legs (one-cancels-other). TP legs reduce the
// open size; when remaining size hits 0 the position is closed at the
// last TP fill price. All transitions write `fill`/`close` audit packets
// so paper and real audit trails are symmetric.
export async function syncPaperMissionExecution(missionId: number): Promise<void> {
  const missionRow = await db.query.missions.findFirst({ where: eq(missions.id, missionId) });
  const cycle = missionRow?.cycleCount ?? 0;
  const position = await db.query.executionPositions.findFirst({
    where: and(
      eq(executionPositions.missionId, missionId),
      eq(executionPositions.status, "open"),
      eq(executionPositions.paper, true),
    ),
  });
  if (!position) return;
  const openLegs = await db.query.executionOrders.findMany({
    where: and(
      eq(executionOrders.missionId, missionId),
      eq(executionOrders.status, "open"),
      eq(executionOrders.paper, true),
    ),
  });
  if (openLegs.length === 0) return;

  let mark: number;
  try { mark = (await getMarketSnapshot(position.symbol)).markPrice; }
  catch { return; }

  const isLong = position.side === "long";
  const triggered: { leg: typeof openLegs[number]; px: number }[] = [];
  for (const leg of openLegs) {
    if (!leg.reduceOnly || leg.triggerPx == null) continue;
    const t = leg.triggerPx;
    let hit = false;
    if (leg.kind === "stop") {
      hit = isLong ? mark <= t : mark >= t;
    } else if (leg.kind === "tp1" || leg.kind === "tp2") {
      hit = isLong ? mark >= t : mark <= t;
    }
    if (hit) triggered.push({ leg, px: t });
  }
  if (triggered.length === 0) return;

  // Stop hit takes priority over TPs (one-cancels-other on the real exchange).
  const stopHit = triggered.find((x) => x.leg.kind === "stop");
  const dir = isLong ? 1 : -1;

  if (stopHit) {
    const closePx = stopHit.px;
    await db.transaction(async (tx) => {
      await tx.update(executionOrders).set({
        status: "filled", filledSz: stopHit.leg.sz, avgFillPx: closePx, updatedAt: new Date(),
      }).where(eq(executionOrders.id, stopHit.leg.id));
      const otherOpenIds = openLegs.filter((l) => l.id !== stopHit.leg.id).map((l) => l.id);
      if (otherOpenIds.length > 0) {
        await tx.update(executionOrders).set({
          status: "cancelled",
          errorMessage: "Cancelled by stop trigger (paper OCO)",
          updatedAt: new Date(),
        }).where(inArray(executionOrders.id, otherOpenIds));
      }
      const realized = (closePx - position.entryPx) * position.sz * dir;
      await tx.update(executionPositions).set({
        status: "closed", closedAt: new Date(),
        unrealizedPnlUsd: realized, lastSyncedAt: new Date(),
      }).where(eq(executionPositions.id, position.id));
      await tx.update(missions).set({
        status: "completed", currentPhase: null, updatedAt: new Date(),
      }).where(eq(missions.id, missionId));
    });
    // Strict completeness: every state change to `cancelled` must produce
    // its own ledger `cancel` entry, not be implicit in the stop-fill row.
    const otherOpenIds = openLegs.filter((l) => l.id !== stopHit.leg.id).map((l) => l.id);
    if (otherOpenIds.length > 0) {
      await audit(missionId, cycle, "cancel",
        `PAPER OCO cancel: ${otherOpenIds.length} reduce-only leg(s) cancelled by stop trigger`,
        { reason: "stop_trigger", cancelledRowIds: otherOpenIds, mark, stopPx: closePx },
        "executor.paper");
    }
    await audit(missionId, cycle, "fill",
      `PAPER stop @ ${closePx} (mark=${mark})`, { kind: "stop", px: closePx, mark });
    await audit(missionId, cycle, "close",
      `PAPER position closed by stop @ ${closePx} (realized ${(((closePx - position.entryPx) * position.sz * dir)).toFixed(2)} USD)`,
      { closedPx: closePx, realized: (closePx - position.entryPx) * position.sz * dir });
    return;
  }

  // Otherwise, fill any triggered TP legs. Reduce the position size by the
  // total TP-filled reduce-only size; if remaining <= 0, close the position
  // at the last TP fill price.
  let remaining = position.sz;
  const filledTpIds: number[] = [];
  let lastFillPx = mark;
  for (const { leg, px } of triggered) {
    const fillSz = Math.min(leg.sz, remaining);
    if (fillSz <= 0) break;
    filledTpIds.push(leg.id);
    remaining -= fillSz;
    lastFillPx = px;
    await db.update(executionOrders).set({
      status: "filled", filledSz: fillSz, avgFillPx: px, updatedAt: new Date(),
    }).where(eq(executionOrders.id, leg.id));
    await audit(missionId, cycle, "fill",
      `PAPER ${leg.kind} @ ${px} (mark=${mark}, sz=${fillSz})`,
      { kind: leg.kind, px, mark, sz: fillSz });
  }
  if (remaining <= 1e-9) {
    const realized = (lastFillPx - position.entryPx) * position.sz * dir;
    const stillOpen = openLegs
      .filter((l) => !filledTpIds.includes(l.id) && l.status === "open")
      .map((l) => l.id);
    await db.transaction(async (tx) => {
      // Cancel any still-open legs (e.g. unfired stop) — position is flat.
      if (stillOpen.length > 0) {
        await tx.update(executionOrders).set({
          status: "cancelled",
          errorMessage: "Cancelled after position closed by TP (paper OCO)",
          updatedAt: new Date(),
        }).where(inArray(executionOrders.id, stillOpen));
      }
      await tx.update(executionPositions).set({
        status: "closed", closedAt: new Date(),
        unrealizedPnlUsd: realized, lastSyncedAt: new Date(),
      }).where(eq(executionPositions.id, position.id));
      await tx.update(missions).set({
        status: "completed", currentPhase: null, updatedAt: new Date(),
      }).where(eq(missions.id, missionId));
    });
    if (stillOpen.length > 0) {
      await audit(missionId, cycle, "cancel",
        `PAPER OCO cancel: ${stillOpen.length} leg(s) cancelled after TP-driven close`,
        { reason: "tp_close", cancelledRowIds: stillOpen, lastFillPx },
        "executor.paper");
    }
    await audit(missionId, cycle, "close",
      `PAPER position closed by TP @ ${lastFillPx} (realized ${realized.toFixed(2)} USD)`,
      { closedPx: lastFillPx, realized });
  }
}

// Refresh unrealizedPnlUsd for an open position from the live mark — called
// from the execution status endpoint so the UI sees fresh PnL on every poll
// without a separate background job.
export async function syncPositionPnl(missionId: number): Promise<void> {
  const pos = await db.query.executionPositions.findFirst({
    where: and(
      eq(executionPositions.missionId, missionId),
      eq(executionPositions.status, "open"),
    ),
  });
  if (!pos) return;
  let mark: number;
  try { mark = (await getMarketSnapshot(pos.symbol)).markPrice; }
  catch { return; }
  const dir = pos.side === "long" ? 1 : -1;
  const pnl = (mark - pos.entryPx) * pos.sz * dir;
  await db.update(executionPositions).set({
    unrealizedPnlUsd: pnl,
    lastSyncedAt: new Date(),
  }).where(eq(executionPositions.id, pos.id));
}

// Used by listMissions/etc. to know how many concurrent live positions exist.
export async function countOpenPositions(): Promise<number> {
  return db.$count(executionPositions, eq(executionPositions.status, "open"));
}

// Suppress unused-import lint for `ne` (kept for future filters).
void ne;

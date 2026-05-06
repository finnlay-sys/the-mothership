import { Router } from "express";
import { db, executionConfig, executionOrders, executionPositions } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  ExecutionError,
  executeMission,
  killExecution,
  getOrCreateConfig,
  redactConfig,
  syncPositionPnl,
  syncMissionExecutionFromExchange,
  syncPaperMissionExecution,
} from "../lib/execution-engine";
import { encryptSecret } from "../lib/encryption";
import { z } from "zod";

const router = Router();

// Shared-secret guard for the live-trading surface. Behaviour:
//   - In NODE_ENV=production, EXECUTION_OPERATOR_TOKEN MUST be set or
//     every request returns 503 (secure-by-default — refuse to serve
//     credential management or order placement when unauthenticated).
//   - When the token is set (any env), every request must present a
//     matching `x-operator-token` header or it is rejected with 401.
//   - In dev (NODE_ENV !== "production") with no token configured, the
//     router is open to match the rest of this currently-unauthenticated
//     API and keep local development frictionless.
// The web client (lib/api-client-react custom-fetch) injects the header
// from a per-browser token saved on the EXECUTION.CONTROL page, so a
// production operator can configure the secret once and operate
// normally from the UI.
router.use((req, res, next) => {
  const expected = process.env.EXECUTION_OPERATOR_TOKEN;
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({
        error: "execution endpoints disabled: EXECUTION_OPERATOR_TOKEN must be set in production",
      });
      return;
    }
    return next();
  }
  const got = req.header("x-operator-token");
  if (got && got === expected) return next();
  res.status(401).json({ error: "execution endpoints require x-operator-token" });
});

// ── Config (singleton) ────────────────────────────────────────────────────────

router.get("/execution/config", async (req, res) => {
  try {
    const cfg = await getOrCreateConfig();
    res.json(redactConfig(cfg));
  } catch (err) {
    req.log.error({ err }, "getExecutionConfig error");
    res.status(500).json({ error: "Internal server error" });
  }
});

const UpdateConfigBody = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullish(),
  // Sending an empty string clears the stored key.
  privateKey: z.string().nullish(),
  useTestnet: z.boolean().optional(),
  paperMode: z.boolean().optional(),
  notionalPerTradeUsd: z.number().positive().max(1_000_000).optional(),
  maxNotionalUsd: z.number().positive().max(10_000_000).optional(),
  maxConcurrentTrades: z.number().int().min(1).max(20).optional(),
  defaultLeverage: z.number().int().min(1).max(50).optional(),
});

router.put("/execution/config", async (req, res) => {
  try {
    const parsed = UpdateConfigBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    await getOrCreateConfig(); // ensure singleton exists

    const updates: Partial<typeof executionConfig.$inferInsert> = { updatedAt: new Date() };
    if (body.walletAddress !== undefined) updates.walletAddress = body.walletAddress;
    if (body.useTestnet !== undefined) updates.useTestnet = body.useTestnet;
    if (body.paperMode !== undefined) updates.paperMode = body.paperMode;
    if (body.notionalPerTradeUsd !== undefined) updates.notionalPerTradeUsd = body.notionalPerTradeUsd;
    if (body.maxNotionalUsd !== undefined) updates.maxNotionalUsd = body.maxNotionalUsd;
    if (body.maxConcurrentTrades !== undefined) updates.maxConcurrentTrades = body.maxConcurrentTrades;
    if (body.defaultLeverage !== undefined) updates.defaultLeverage = body.defaultLeverage;

    if (body.privateKey !== undefined) {
      if (body.privateKey === null || body.privateKey === "") {
        updates.encryptedPrivateKey = null;
      } else {
        const pk = body.privateKey.trim();
        if (!/^(0x)?[a-fA-F0-9]{64}$/.test(pk)) {
          res.status(400).json({ error: "privateKey must be a 32-byte hex string (with or without 0x prefix)" });
          return;
        }
        const normalizedPk = pk.startsWith("0x") ? pk : `0x${pk}`;
        // Wallet/key consistency: if the caller is also setting (or has
        // already set) walletAddress, derive the address from this key
        // and reject mismatches. Otherwise reconciliation/monitoring,
        // which is keyed on stored walletAddress, will silently look at
        // the wrong account.
        const { privateKeyToAccount } = await import("viem/accounts");
        const derived = privateKeyToAccount(normalizedPk as `0x${string}`).address.toLowerCase();
        const claimedRaw = body.walletAddress !== undefined
          ? body.walletAddress
          : (await getOrCreateConfig()).walletAddress;
        if (claimedRaw && claimedRaw.toLowerCase() !== derived) {
          res.status(400).json({
            error: `walletAddress (${claimedRaw}) does not match the address derived from privateKey (${derived}). Either update walletAddress or supply the matching key.`,
          });
          return;
        }
        // If no wallet was supplied/stored, auto-pin it from the key so
        // downstream code always has a non-null walletAddress to use.
        if (!claimedRaw) updates.walletAddress = derived;
        updates.encryptedPrivateKey = encryptSecret(normalizedPk);
      }
    }

    await db.update(executionConfig).set(updates).where(eq(executionConfig.id, 1));
    const cfg = await getOrCreateConfig();
    res.json(redactConfig(cfg));
  } catch (err) {
    req.log.error({ err }, "updateExecutionConfig error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Per-mission execution ────────────────────────────────────────────────────

router.post("/missions/:id/execute", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid mission id" }); return; }
  try {
    const result = await executeMission(id);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ExecutionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err, missionId: id }, "executeMission error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/missions/:id/execute/kill", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid mission id" }); return; }
  try {
    const result = await killExecution(id);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof ExecutionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err, missionId: id }, "killExecution error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/missions/:id/execution", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid mission id" }); return; }
  try {
    // Best-effort PnL refresh; never fail the read because the live mark
    // fetch hiccups.
    // Lifecycle sync first (detect SL/TP fills + natural closes), then refresh
    // unrealized PnL on whatever remains open. Both are best-effort.
    try { await syncMissionExecutionFromExchange(id); } catch (e) { req.log.warn({ err: e }, "exchange sync failed"); }
    try { await syncPaperMissionExecution(id); } catch (e) { req.log.warn({ err: e }, "paper sync failed"); }
    try { await syncPositionPnl(id); } catch (e) { req.log.warn({ err: e }, "pnl sync failed"); }

    const orders = await db.query.executionOrders.findMany({
      where: eq(executionOrders.missionId, id),
      orderBy: [desc(executionOrders.createdAt)],
    });
    const position = await db.query.executionPositions.findFirst({
      where: and(eq(executionPositions.missionId, id), eq(executionPositions.status, "open")),
    });
    const lastClosed = position
      ? null
      : await db.query.executionPositions.findFirst({
          where: eq(executionPositions.missionId, id),
          orderBy: [desc(executionPositions.openedAt)],
        });
    res.json({ orders, position: position ?? lastClosed ?? null });
  } catch (err) {
    req.log.error({ err, missionId: id }, "getExecution error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

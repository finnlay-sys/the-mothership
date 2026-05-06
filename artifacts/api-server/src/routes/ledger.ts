import { Router } from "express";
import { z } from "zod";
import {
  readLedger, verifyLedger, verifyMissionSlice, exportLedgerSigned,
  LEDGER_ACTIONS, type LedgerAction,
} from "../lib/ledger";

const router = Router();

// Read-only by design. The ledger is append-only at the storage layer; this
// router intentionally exposes no POST/PUT/DELETE so an attacker who
// compromises the API surface still cannot mutate prior entries.

const querySchema = z.object({
  missionId: z.coerce.number().int().positive().optional(),
  action: z.enum(LEDGER_ACTIONS).optional(),
  after: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get("/ledger", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid query", details: parsed.error.format() });
    return;
  }
  const q = parsed.data;
  try {
    const result = await readLedger({
      missionId: q.missionId ?? null,
      action: (q.action as LedgerAction | undefined) ?? null,
      after: q.after ?? null,
      before: q.before ?? null,
      limit: q.limit,
      offset: q.offset,
    });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "ledger read failed");
    res.status(500).json({ error: "ledger read failed" });
  }
});

router.get("/ledger/verify", async (req, res) => {
  try {
    const result = await verifyLedger();
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "ledger verify failed");
    res.status(500).json({ error: "ledger verify failed" });
  }
});

router.get("/ledger/missions/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid mission id" });
      return;
    }
    const parsed = querySchema.partial().safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid query", details: parsed.error.format() });
      return;
    }
    const q = parsed.data;
    const result = await readLedger({
      missionId: id,
      action: (q.action as LedgerAction | undefined) ?? null,
      after: q.after ?? null,
      before: q.before ?? null,
      limit: q.limit,
      offset: q.offset,
    });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "ledger mission read failed");
    res.status(500).json({ error: "ledger mission read failed" });
  }
});

router.get("/ledger/missions/:id/verify", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid mission id" });
      return;
    }
    const slice = await verifyMissionSlice(id);
    // Keep the existing top-level fields for UI compatibility while exposing
    // the new mission-anchored fields.
    res.json({
      ok: slice.ok,
      totalEntries: slice.totalEntries,
      lastHash: slice.missionLastHash ?? "0".repeat(64),
      brokeAtIndex: slice.brokeAtIndex,
      brokeAtReason: slice.brokeAtReason,
      missionEntries: slice.missionEntries,
      missionFirstIndex: slice.missionFirstIndex,
      missionLastIndex: slice.missionLastIndex,
      missionLastHash: slice.missionLastHash,
    });
  } catch (err) {
    req.log.error({ err }, "ledger mission verify failed");
    res.status(500).json({ error: "ledger mission verify failed" });
  }
});

router.get("/ledger/export", async (req, res) => {
  try {
    const { body, manifest } = await exportLedgerSigned();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="mothership-ledger-${stamp}.signed.jsonl"`,
    );
    res.setHeader("X-Ledger-Signature", manifest.signature);
    res.setHeader("X-Ledger-Last-Hash", manifest.lastHash);
    res.setHeader("X-Ledger-Entry-Count", String(manifest.entryCount));
    res.send(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ledger export failed";
    req.log.error({ err }, "ledger export failed");
    // Surface the missing-signing-key configuration error as 503 so the
    // operator sees a clear, actionable message instead of a generic 500.
    const isConfigErr = msg.startsWith("ledger signing key missing");
    res.status(isConfigErr ? 503 : 500).json({ error: msg });
  }
});

export default router;

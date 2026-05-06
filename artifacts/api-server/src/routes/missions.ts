import { Router } from "express";
import { db } from "@workspace/db";
import { missions, reasoningPackets, vetoes, governanceRules } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { runMothershipCycle, executeDeliverable, type AgentEvent } from "../lib/mothership-engine";
import { isValidPerpSymbol } from "../lib/hyperliquid-client";
import { executeMission, getOrCreateConfig, ExecutionError } from "../lib/execution-engine";
import { logger } from "../lib/logger";
import {
  CreateMissionBody,
  QueenApproveBody,
  QueenVetoBody,
  QueenInterveneBody
} from "@workspace/api-zod";

const router = Router();

router.get("/missions", async (req, res) => {
  try {
    const list = await db.query.missions.findMany({
      orderBy: [desc(missions.createdAt)]
    });
    res.json(list.map(m => ({
      id: m.id,
      primeObjective: m.primeObjective,
      status: m.status,
      cycleCount: m.cycleCount,
      currentPhase: m.currentPhase,
      thesisLock: m.thesisLock,
      targetSymbol: m.targetSymbol,
      speedMode: m.speedMode,
      costUsd: m.costUsd ?? 0,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt
    })));
  } catch (err) {
    req.log.error({ err }, "listMissions error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/missions", async (req, res) => {
  try {
    const parsed = CreateMissionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }
    let targetSymbol: string | null = null;
    if (parsed.data.targetSymbol != null && parsed.data.targetSymbol !== "") {
      const candidate = parsed.data.targetSymbol.trim().toUpperCase();
      if (!/^[A-Z0-9]{1,15}$/.test(candidate)) {
        res.status(400).json({ error: "targetSymbol must be 1-15 alphanumeric chars" });
        return;
      }
      // Fail closed: if we can't confirm the symbol exists on Hyperliquid we
      // refuse the mission. Accepting unknown symbols would let agents debate
      // a "blind" target with no market context, which Phase 3 explicitly
      // forbids.
      try {
        const ok = await isValidPerpSymbol(candidate);
        if (!ok) {
          res.status(400).json({ error: `Unknown Hyperliquid perp symbol: ${candidate}` });
          return;
        }
      } catch (err) {
        req.log.error({ err }, "perp universe lookup failed; rejecting mission");
        res.status(503).json({ error: "Could not verify symbol against Hyperliquid universe; try again shortly." });
        return;
      }
      targetSymbol = candidate;
    }

    // Default to "scalp" so missions created from older clients still get the
    // fast-debate cadence; only "swing" opts back into the slower 4-cycle path.
    const speedMode = parsed.data.speedMode === "swing" ? "swing" : "scalp";

    const [mission] = await db.insert(missions).values({
      primeObjective: parsed.data.primeObjective,
      status: "pending",
      cycleCount: 0,
      targetSymbol,
      speedMode,
    }).returning();
    res.status(201).json({
      id: mission.id,
      primeObjective: mission.primeObjective,
      status: mission.status,
      cycleCount: mission.cycleCount,
      currentPhase: mission.currentPhase,
      thesisLock: mission.thesisLock,
      targetSymbol: mission.targetSymbol,
      speedMode: mission.speedMode,
      costUsd: mission.costUsd ?? 0,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt
    });
  } catch (err) {
    req.log.error({ err }, "createMission error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/missions/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const mission = await db.query.missions.findFirst({ where: eq(missions.id, id) });
    if (!mission) { res.status(404).json({ error: "Not found" }); return; }
    res.json({
      id: mission.id,
      primeObjective: mission.primeObjective,
      status: mission.status,
      cycleCount: mission.cycleCount,
      currentPhase: mission.currentPhase,
      thesisLock: mission.thesisLock,
      targetSymbol: mission.targetSymbol,
      speedMode: mission.speedMode,
      costUsd: mission.costUsd ?? 0,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt
    });
  } catch (err) {
    req.log.error({ err }, "getMission error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/missions/:id/status", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const mission = await db.query.missions.findFirst({ where: eq(missions.id, id) });
    if (!mission) { res.status(404).json({ error: "Not found" }); return; }
    const lastPacket = await db.query.reasoningPackets.findFirst({
      where: eq(reasoningPackets.missionId, id),
      orderBy: [desc(reasoningPackets.createdAt)]
    });
    res.json({
      id: mission.id,
      status: mission.status,
      cycleCount: mission.cycleCount,
      currentPhase: mission.currentPhase,
      lastPacketAt: lastPacket?.createdAt ?? null
    });
  } catch (err) {
    req.log.error({ err }, "getMissionStatus error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/missions/:id/run", async (req, res) => {
  const id = parseInt(req.params.id);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const sendEvent = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  req.on("close", () => {
    res.end();
  });

  try {
    await runMothershipCycle(id, sendEvent);
  } catch (err) {
    sendEvent({ type: "error", data: { message: err instanceof Error ? err.message : "Unknown error" } });
  }

  res.end();
});

router.get("/missions/:id/reasoning-packets", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const packets = await db.query.reasoningPackets.findMany({
      where: eq(reasoningPackets.missionId, id),
      orderBy: [desc(reasoningPackets.createdAt)]
    });
    res.json(packets.map(p => ({
      id: p.id,
      missionId: p.missionId,
      cycle: p.cycle,
      agentRole: p.agentRole,
      reasoning: p.reasoning,
      proposal: p.proposal,
      verdict: p.verdict,
      alignmentScore: p.alignmentScore,
      annotations: p.annotations ?? null,
      tokensIn: p.tokensIn ?? null,
      tokensOut: p.tokensOut ?? null,
      reasoningTokens: p.reasoningTokens ?? null,
      costUsd: p.costUsd ?? null,
      durationMs: p.durationMs ?? null,
      createdAt: p.createdAt
    })));
  } catch (err) {
    req.log.error({ err }, "getReasoningPackets error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/missions/:id/vetoes", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const missionVetoes = await db.query.vetoes.findMany({
      where: eq(vetoes.missionId, id),
      orderBy: [desc(vetoes.createdAt)]
    });
    res.json(missionVetoes.map(v => ({
      id: v.id,
      missionId: v.missionId,
      cycle: v.cycle,
      vetoedBy: v.vetoedBy,
      reason: v.reason,
      proposalSummary: v.proposalSummary,
      createdAt: v.createdAt
    })));
  } catch (err) {
    req.log.error({ err }, "getMissionVetoes error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/missions/:id/queen/approve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const parsed = QueenApproveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" }); return;
    }

    const mission = await db.query.missions.findFirst({ where: eq(missions.id, id) });
    if (!mission) { res.status(404).json({ error: "Not found" }); return; }

    const cycle = mission.cycleCount ?? 0;

    await db.insert(reasoningPackets).values({
      missionId: id,
      cycle,
      agentRole: "queen",
      reasoning: `Queen approved the Thesis Lock. Reason: ${parsed.data.reason}`,
      proposal: parsed.data.thesisLock ?? mission.thesisLock,
    });

    const finalThesis = parsed.data.thesisLock ?? mission.thesisLock ?? "";

    // Persist the locked thesis text immediately, but DO NOT pre-flip
    // status to "executing" here. The previous version did, and that
    // preempted executeMission's single-flight claim (which only matches
    // status IN ('awaiting_queen','locked')) — every paper auto-execute
    // hit 409 silently and no trade ever ran. We let executeMission own
    // the status flip when it auto-fires; if there's no trade to fire,
    // the deliverable kickoff below sets it instead.
    await db.update(missions).set({
      thesisLock: finalThesis,
      updatedAt: new Date(),
    }).where(eq(missions.id, id));

    // ── Auto-execute decision (option 3) ─────────────────────────────────
    // After a thesis lock, decide whether to also fire the actual Hyperliquid
    // bracket placement. We auto-execute ONLY in paper mode (harmless,
    // simulated) and ONLY when the mission carries a structured trade plan
    // we can place. In real mode the operator must explicitly press
    // EXECUTE TRADE NOW on the mission console — a deliberate two-click
    // gate so live capital is never moved by a single click.
    //
    // Order matters: this MUST run before the executor/deliverable status
    // flip below so executeMission's single-flight claim can succeed
    // against status='awaiting_queen'.
    let autoExecuteScheduled = false;
    let executionMode: "paper" | "real" | null = null;
    let autoSkipReason: string | null = null;
    try {
      const fv = mission.finalVerdictJson as
        | { stance?: string; tradePlan?: { symbol?: string; bias?: string } }
        | null;
      const hasPlaceablePlan = !!fv
        && fv.stance !== "STAND_DOWN"
        && !!fv.tradePlan?.symbol
        && fv.tradePlan?.bias !== "FLAT";
      if (!hasPlaceablePlan) {
        autoSkipReason = !fv
          ? "no structured Final Verdict"
          : fv.stance === "STAND_DOWN"
          ? "verdict stance is STAND_DOWN"
          : !fv.tradePlan?.symbol
          ? "trade plan missing symbol"
          : "trade plan bias is FLAT";
      } else {
        const cfg = await getOrCreateConfig();
        executionMode = cfg.paperMode ? "paper" : "real";
        if (cfg.paperMode) {
          autoExecuteScheduled = true;
          // Background fire — must not block the approve response. Failures
          // are logged + recorded as an executor ERROR packet so the operator
          // sees them in the mission feed without polluting the click-path.
          // The ledger (Task #37) also records the submit/error chain.
          void executeMission(id).catch(async (err) => {
            // A 409 here is rare now that we fire BEFORE the status flip:
            // it can only mean a duplicate approve / manual execute click
            // raced ahead of us. Treat it as "another execute already in
            // flight" and stay quiet so we don't dump a misleading ERROR
            // packet alongside the winning execution's audit trail.
            if (err instanceof ExecutionError && err.status === 409) {
              logger.info({ missionId: id },
                "auto-execute (paper) skipped: another execute already in flight");
              return;
            }
            const msg = err instanceof ExecutionError
              ? `${err.message} (${err.status})`
              : err instanceof Error ? err.message : String(err);
            logger.warn({ err, missionId: id }, "auto-execute (paper) failed");
            try {
              await db.insert(reasoningPackets).values({
                missionId: id,
                cycle: mission.cycleCount ?? 0,
                agentRole: "executor",
                reasoning: `Auto-execute (paper) failed: ${msg}`,
                proposal: null,
                verdict: "ERROR",
              });
            } catch (e) {
              logger.error({ err: e, missionId: id },
                "auto-execute error-audit insert failed");
            }
          });
        } else {
          autoSkipReason = "real mode — operator must press EXECUTE TRADE NOW";
        }
      }
    } catch (err) {
      // Config lookup failure must not break the approve flow — operator
      // can still trigger manual execute from the EXECUTION console.
      logger.warn({ err, missionId: id },
        "queenApprove: auto-execute decision skipped");
      autoSkipReason = `decision error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Always leave a forensic breadcrumb of the auto-execute decision in
    // the reasoning packet stream, even on no-op paths. Without this the
    // operator sees no evidence of what happened between LOCK THESIS and
    // (possibly absent) execution rows.
    try {
      await db.insert(reasoningPackets).values({
        missionId: id,
        cycle: mission.cycleCount ?? 0,
        agentRole: "executor",
        reasoning: autoExecuteScheduled
          ? `Auto-execute scheduled (paper mode) — bracket submission running in background.`
          : `Auto-execute skipped — ${autoSkipReason ?? "unknown reason"}.`,
        proposal: null,
        verdict: autoExecuteScheduled ? "AUTO_EXECUTE" : "AUTO_EXECUTE_SKIPPED",
      });
    } catch (err) {
      logger.warn({ err, missionId: id }, "auto-execute breadcrumb insert failed");
    }

    // Now flip status for the deliverable LLM kickoff. When the paper
    // auto-execute fired above, executeMission has either already set
    // status="executing"+currentPhase="live" (success) or released the
    // claim back to its previous value (failure) — either way this update
    // is harmless because the deliverable owns its own terminal status
    // ("completed" on success, "locked" on failure).
    if (!autoExecuteScheduled) {
      await db.update(missions).set({
        status: "executing",
        currentPhase: "executor",
        updatedAt: new Date(),
      }).where(eq(missions.id, id));
    }

    // Fire deliverable generation in the background — slow LLM call, frontend polls for result.
    // The catch block must be fully defensive: any uncaught throw here becomes
    // an unhandledRejection and crashes the API server (e.g. if the mission
    // was deleted out from under us between approve and the failure handler).
    executeDeliverable(id, mission.primeObjective, finalThesis, parsed.data.reason)
      .catch(async (err) => {
        req.log.error({ err }, "executeDeliverable failed");
        try {
          await db.insert(reasoningPackets).values({
            missionId: id,
            cycle: mission.cycleCount ?? 0,
            agentRole: "executor",
            reasoning: `Executor failed: ${err instanceof Error ? err.message : String(err)}`,
            proposal: null,
            verdict: "ERROR",
          });
        } catch (e) {
          logger.error({ err: e, missionId: id },
            "executeDeliverable error-audit insert failed");
        }
        try {
          // Do not clobber an active execution's status. Only fall back to
          // "locked" when the mission is still in a deliverable-controlled
          // state (so we don't downgrade a running paper trade).
          await db.update(missions)
            .set({ status: "locked", currentPhase: null, updatedAt: new Date() })
            .where(and(
              eq(missions.id, id),
              eq(missions.status, "executing"),
              eq(missions.currentPhase, "executor"),
            ));
        } catch (e) {
          logger.error({ err: e, missionId: id },
            "executeDeliverable status revert failed");
        }
      });

    res.json({
      missionId: id,
      decision: "approved",
      reason: parsed.data.reason,
      recordedAt: new Date().toISOString(),
      autoExecuteScheduled,
      executionMode,
    });
  } catch (err) {
    req.log.error({ err }, "queenApprove error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/missions/:id/queen/veto", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const parsed = QueenVetoBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" }); return;
    }

    const mission = await db.query.missions.findFirst({ where: eq(missions.id, id) });
    if (!mission) { res.status(404).json({ error: "Not found" }); return; }

    const cycle = mission.cycleCount ?? 0;

    await db.insert(vetoes).values({
      missionId: id,
      cycle,
      vetoedBy: "queen",
      reason: parsed.data.reason,
      proposalSummary: mission.thesisLock ?? "No thesis lock"
    });

    await db.insert(reasoningPackets).values({
      missionId: id,
      cycle,
      agentRole: "queen",
      reasoning: `Queen issued veto. Reason: ${parsed.data.reason}`,
    });

    await db.update(missions).set({
      status: "vetoed",
      currentPhase: null,
      updatedAt: new Date()
    }).where(eq(missions.id, id));

    res.json({
      missionId: id,
      decision: "vetoed",
      reason: parsed.data.reason,
      recordedAt: new Date().toISOString()
    });
  } catch (err) {
    req.log.error({ err }, "queenVeto error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/missions/:id/kill", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const mission = await db.query.missions.findFirst({ where: eq(missions.id, id) });
    if (!mission) { res.status(404).json({ error: "Not found" }); return; }

    const TERMINAL = ["completed", "vetoed", "aborted"];
    if (TERMINAL.includes(mission.status)) {
      res.status(400).json({ error: `Mission is already ${mission.status} — cannot kill` });
      return;
    }

    const cycle = mission.cycleCount ?? 0;

    await db.update(missions).set({
      status: "aborted",
      currentPhase: null,
      updatedAt: new Date()
    }).where(eq(missions.id, id));

    await db.insert(reasoningPackets).values({
      missionId: id,
      cycle,
      agentRole: "system",
      reasoning: "Operator triggered kill switch — mission aborted.",
      verdict: "ABORTED",
    });

    res.json({
      missionId: id,
      decision: "aborted",
      reason: "Operator triggered kill switch",
      recordedAt: new Date().toISOString()
    });
  } catch (err) {
    req.log.error({ err }, "killMission error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/missions/:id/queen/intervene", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const parsed = QueenInterveneBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" }); return;
    }

    const mission = await db.query.missions.findFirst({ where: eq(missions.id, id) });
    if (!mission) { res.status(404).json({ error: "Not found" }); return; }

    if (mission.status !== "awaiting_intervention") {
      res.status(400).json({ error: `Mission is not awaiting intervention (status: ${mission.status})` });
      return;
    }

    const cycle = mission.cycleCount ?? 0;

    await db.insert(reasoningPackets).values({
      missionId: id,
      cycle,
      agentRole: "queen",
      reasoning: `Queen issued intervention guidance after worker deadlock at cycle ${cycle}.`,
      proposal: parsed.data.guidance,
      verdict: "INTERVENTION",
    });

    await db.update(missions).set({
      status: "pending",
      currentPhase: null,
      updatedAt: new Date()
    }).where(eq(missions.id, id));

    res.json({
      missionId: id,
      decision: "approved",
      reason: `Intervention guidance issued: ${parsed.data.guidance.substring(0, 200)}`,
      recordedAt: new Date().toISOString()
    });
  } catch (err) {
    req.log.error({ err }, "queenIntervene error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

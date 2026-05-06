import { Router } from "express";
import { db } from "@workspace/db";
import { missions, reasoningPackets, vetoes } from "@workspace/db";
import { eq, desc, count, avg, isNotNull } from "drizzle-orm";

const router = Router();

router.get("/audit/recent", async (req, res) => {
  try {
    const recentPackets = await db.query.reasoningPackets.findMany({
      orderBy: [desc(reasoningPackets.createdAt)],
      limit: 20
    });
    const recentVetoes = await db.query.vetoes.findMany({
      orderBy: [desc(vetoes.createdAt)],
      limit: 10
    });
    res.json({ recentPackets, recentVetoes });
  } catch (err) {
    req.log.error({ err }, "getRecentAuditEntries error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/audit/stats", async (req, res) => {
  try {
    const [missionStats] = await db.select({
      totalMissions: count()
    }).from(missions);

    const activeMissionsResult = await db.query.missions.findMany({
      where: eq(missions.status, "running")
    });

    const [packetStats] = await db.select({
      totalPackets: count(),
      avgScore: avg(reasoningPackets.alignmentScore)
    }).from(reasoningPackets).where(isNotNull(reasoningPackets.alignmentScore));

    const [allPackets] = await db.select({ total: count() }).from(reasoningPackets);

    const [vetoStats] = await db.select({
      totalVetoes: count()
    }).from(vetoes);

    const totalPackets = allPackets?.total ?? 0;
    const totalVetoes = Number(vetoStats?.totalVetoes ?? 0);

    res.json({
      totalMissions: Number(missionStats?.totalMissions ?? 0),
      activeMissions: activeMissionsResult.length,
      totalPackets: Number(totalPackets),
      totalVetoes,
      avgAlignmentScore: packetStats?.avgScore ? parseFloat(String(packetStats.avgScore)) : null,
      vetoRate: totalPackets > 0 ? totalVetoes / Number(totalPackets) : null
    });
  } catch (err) {
    req.log.error({ err }, "getAuditStats error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

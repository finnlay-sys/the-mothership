import { Router } from "express";
import { db } from "@workspace/db";
import { governanceRules } from "@workspace/db";
import { desc } from "drizzle-orm";
import { CreateRuleBody } from "@workspace/api-zod";

const router = Router();

router.get("/rules", async (req, res) => {
  try {
    const rules = await db.query.governanceRules.findMany({
      orderBy: [desc(governanceRules.createdAt)]
    });
    res.json(rules.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      severity: r.severity,
      active: r.active,
      createdAt: r.createdAt
    })));
  } catch (err) {
    req.log.error({ err }, "listRules error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/rules", async (req, res) => {
  try {
    const parsed = CreateRuleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }
    const [rule] = await db.insert(governanceRules).values({
      name: parsed.data.name,
      description: parsed.data.description,
      severity: parsed.data.severity,
      active: true
    }).returning();
    res.status(201).json({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      severity: rule.severity,
      active: rule.active,
      createdAt: rule.createdAt
    });
  } catch (err) {
    req.log.error({ err }, "createRule error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

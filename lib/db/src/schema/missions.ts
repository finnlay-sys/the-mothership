import { pgTable, serial, text, integer, real, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const missions = pgTable("missions", {
  id: serial("id").primaryKey(),
  primeObjective: text("prime_objective").notNull(),
  status: text("status").notNull().default("pending"),
  cycleCount: integer("cycle_count").notNull().default(0),
  currentPhase: text("current_phase"),
  thesisLock: text("thesis_lock"),
  targetSymbol: text("target_symbol"),
  costUsd: real("cost_usd").notNull().default(0),
  speedMode: text("speed_mode").notNull().default("scalp"),
  // Structured Queen FINAL_VERDICT payload (latest one wins). Populated by
  // mothership-engine.queenFinalVerdict() so the /execute route can read
  // numeric entry/stop/TPs without re-parsing markdown.
  finalVerdictJson: jsonb("final_verdict_json"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertMissionSchema = createInsertSchema(missions).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMission = z.infer<typeof insertMissionSchema>;
export type Mission = typeof missions.$inferSelect;

export const reasoningPackets = pgTable("reasoning_packets", {
  id: serial("id").primaryKey(),
  missionId: integer("mission_id").notNull().references(() => missions.id),
  cycle: integer("cycle").notNull(),
  agentRole: text("agent_role").notNull(),
  reasoning: text("reasoning").notNull(),
  proposal: text("proposal"),
  verdict: text("verdict"),
  alignmentScore: real("alignment_score"),
  annotations: jsonb("annotations"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  reasoningTokens: integer("reasoning_tokens"),
  costUsd: real("cost_usd"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertReasoningPacketSchema = createInsertSchema(reasoningPackets).omit({ id: true, createdAt: true });
export type InsertReasoningPacket = z.infer<typeof insertReasoningPacketSchema>;
export type ReasoningPacket = typeof reasoningPackets.$inferSelect;

export const vetoes = pgTable("vetoes", {
  id: serial("id").primaryKey(),
  missionId: integer("mission_id").notNull().references(() => missions.id),
  cycle: integer("cycle").notNull(),
  vetoedBy: text("vetoed_by").notNull(),
  reason: text("reason").notNull(),
  proposalSummary: text("proposal_summary").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertVetoSchema = createInsertSchema(vetoes).omit({ id: true, createdAt: true });
export type InsertVeto = z.infer<typeof insertVetoSchema>;
export type Veto = typeof vetoes.$inferSelect;

export const governanceRules = pgTable("governance_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  severity: text("severity").notNull().default("medium"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertGovernanceRuleSchema = createInsertSchema(governanceRules).omit({ id: true, createdAt: true });
export type InsertGovernanceRule = z.infer<typeof insertGovernanceRuleSchema>;
export type GovernanceRule = typeof governanceRules.$inferSelect;

// =============================================================================
// EXECUTION (Task #36): Hyperliquid live & paper trading
// =============================================================================

// Singleton row (id = 1). Stores the operator's Hyperliquid wallet credentials
// (encrypted at rest) plus per-account risk caps and the global paper-mode
// toggle. The encrypted blob is AES-256-GCM with a key derived from
// SESSION_SECRET via HKDF-SHA256, so private keys are never echoed back to the
// client and never appear in logs. The wallet ADDRESS is stored in plaintext
// (it is public information) and used to query Info endpoints / display in the
// settings UI.
export const executionConfig = pgTable("execution_config", {
  id: integer("id").primaryKey().default(1),
  walletAddress: text("wallet_address"),
  // JSON-encoded { ciphertext, iv, tag } (all hex). Null when no key is set.
  encryptedPrivateKey: text("encrypted_private_key"),
  useTestnet: boolean("use_testnet").notNull().default(true),
  paperMode: boolean("paper_mode").notNull().default(true),
  notionalPerTradeUsd: real("notional_per_trade_usd").notNull().default(200),
  maxNotionalUsd: real("max_notional_usd").notNull().default(1000),
  maxConcurrentTrades: integer("max_concurrent_trades").notNull().default(2),
  defaultLeverage: integer("default_leverage").notNull().default(3),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ExecutionConfig = typeof executionConfig.$inferSelect;

// One row per Hyperliquid order placed for a mission (entry, stop, take-profits).
// Status moves: pending -> open -> filled / cancelled / rejected / error.
// hlOrderId is null for paper rows and for rows that failed before placement.
export const executionOrders = pgTable("execution_orders", {
  id: serial("id").primaryKey(),
  missionId: integer("mission_id").notNull().references(() => missions.id),
  kind: text("kind").notNull(), // "entry" | "stop" | "tp1" | "tp2"
  side: text("side").notNull(), // "buy" | "sell"
  reduceOnly: boolean("reduce_only").notNull().default(false),
  orderType: text("order_type").notNull(), // "market" | "limit" | "trigger"
  triggerPx: real("trigger_px"),
  limitPx: real("limit_px"),
  sz: real("sz").notNull(),
  hlOrderId: text("hl_order_id"),
  status: text("status").notNull().default("pending"),
  filledSz: real("filled_sz").notNull().default(0),
  avgFillPx: real("avg_fill_px"),
  errorMessage: text("error_message"),
  paper: boolean("paper").notNull().default(true),
  // Venue this order was placed against — captured at placement time so KILL
  // and lifecycle sync target the original network even if the global
  // useTestnet config is toggled afterwards.
  useTestnet: boolean("use_testnet").notNull().default(true),
  // Wallet that placed this order. Pinned per row so credential rotation on
  // the global config cannot misroute reconciliation/KILL onto the wrong
  // account. Null for paper rows.
  walletAddress: text("wallet_address"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ExecutionOrder = typeof executionOrders.$inferSelect;

// Per-mission position state. One open row per mission at most.
// status moves: open -> closed (TP/manual) | killed (KILL switch).
export const executionPositions = pgTable("execution_positions", {
  id: serial("id").primaryKey(),
  missionId: integer("mission_id").notNull().references(() => missions.id),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(), // "long" | "short"
  sz: real("sz").notNull(),
  entryPx: real("entry_px").notNull(),
  unrealizedPnlUsd: real("unrealized_pnl_usd").notNull().default(0),
  realizedPnlUsd: real("realized_pnl_usd").notNull().default(0),
  status: text("status").notNull().default("open"),
  paper: boolean("paper").notNull().default(true),
  // See executionOrders.useTestnet — pinned at placement time.
  useTestnet: boolean("use_testnet").notNull().default(true),
  // See executionOrders.walletAddress.
  walletAddress: text("wallet_address"),
  // Notional USD actually used to size this position (after parsing the
  // verdict's sizing hint and clamping to risk caps). Captured for audit so
  // the operator can see exactly how much was deployed per mission.
  notionalUsdUsed: real("notional_usd_used"),
  openedAt: timestamp("opened_at").notNull().defaultNow(),
  closedAt: timestamp("closed_at"),
  lastSyncedAt: timestamp("last_synced_at").notNull().defaultNow(),
});

export type ExecutionPosition = typeof executionPositions.$inferSelect;

import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { missions, reasoningPackets } from "@workspace/db";
import { logger } from "./logger";
import type { AgentEvent } from "./mothership-engine-types";

// gpt-5-mini published rates (per 1M tokens). Tune both constants in one
// place when OpenAI changes pricing. Reasoning tokens are billed by OpenAI
// as output tokens, so they fold into PRICE_PER_M_OUTPUT_USD.
export const PRICE_PER_M_INPUT_USD = 0.25;
export const PRICE_PER_M_OUTPUT_USD = 2.0;

export type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
} | null | undefined;

export type CostBreakdown = {
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  costUsd: number;
};

export function computeCost(usage: OpenAIUsage): CostBreakdown {
  const tokensIn = usage?.prompt_tokens ?? 0;
  const tokensOut = usage?.completion_tokens ?? 0;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const costUsd =
    (tokensIn / 1_000_000) * PRICE_PER_M_INPUT_USD +
    (tokensOut / 1_000_000) * PRICE_PER_M_OUTPUT_USD;
  return { tokensIn, tokensOut, reasoningTokens, costUsd };
}

// Persist token usage onto a reasoning_packet row AND atomically increment
// the mission's running cost total. Emits a `cost_tick` SSE event so the
// client header ticks live as each agent finishes its API call.
//
// Defensive: any DB error is logged and swallowed — cost accounting must
// never crash the debate.
export async function recordCallCost(args: {
  missionId: number;
  packetId: number | null;
  cycle: number;
  agent: string;
  usage: OpenAIUsage;
  // Wall-clock time in ms the LLM call (including any internal retry like the
  // empty-output retry helper) took. Folded into the packet row and the
  // cost_tick SSE so the operator can see per-agent latency live.
  durationMs?: number;
  sendEvent?: (event: AgentEvent) => void;
}): Promise<CostBreakdown> {
  const breakdown = computeCost(args.usage);

  try {
    if (args.packetId != null) {
      await db
        .update(reasoningPackets)
        .set({
          tokensIn: breakdown.tokensIn,
          tokensOut: breakdown.tokensOut,
          reasoningTokens: breakdown.reasoningTokens,
          costUsd: breakdown.costUsd,
          // Only overwrite if a value was provided — call sites that already
          // wrote durationMs into the insert payload pass it here too, so the
          // update is a no-op for that field but keeps things consistent.
          ...(args.durationMs != null ? { durationMs: args.durationMs } : {}),
        })
        .where(eq(reasoningPackets.id, args.packetId));
    }

    const [updated] = await db
      .update(missions)
      .set({ costUsd: sql`COALESCE(${missions.costUsd}, 0) + ${breakdown.costUsd}` })
      .where(eq(missions.id, args.missionId))
      .returning({ costUsd: missions.costUsd });

    const missionTotalCostUsd = updated?.costUsd ?? breakdown.costUsd;

    args.sendEvent?.({
      type: "cost_tick",
      data: {
        packetId: args.packetId,
        cycle: args.cycle,
        agent: args.agent,
        tokensIn: breakdown.tokensIn,
        tokensOut: breakdown.tokensOut,
        reasoningTokens: breakdown.reasoningTokens,
        callCostUsd: breakdown.costUsd,
        missionTotalCostUsd,
        durationMs: args.durationMs,
      },
    });
  } catch (err) {
    logger.warn(
      { err, missionId: args.missionId, packetId: args.packetId, agent: args.agent },
      "cost accounting failed (non-fatal)",
    );
  }

  return breakdown;
}

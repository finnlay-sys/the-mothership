import { openai } from "./openai-client";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { db } from "@workspace/db";
import { missions, reasoningPackets, vetoes, governanceRules } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { logger } from "./logger";
import {
  safeBuildContextBlock,
  validateLevelCitations,
  HTF_TIMEFRAMES,
  type HtfTimeframe,
  type MarketContext,
} from "./market-context";
import {
  parseAnnotations,
  structuredAnnotationSchema,
  MARKER_KINDS,
  MARKER_POSITIONS,
  MARKER_SHAPES,
  MARKER_COLORS,
  PRICE_LINE_KINDS,
  PRICE_LINE_COLORS,
  type ChartAnnotations,
} from "./annotation-schema";
import { recordCallCost, computeCost, type OpenAIUsage } from "./cost-accounting";
import type { AgentEvent, SendEvent } from "./mothership-engine-types";

export type { AgentEvent, SendEvent };

const ESCALATE_THRESHOLD = 0.85;

// Two-mode debate cadence. SCALP is the default for low-timeframe / live perp
// trading: a confident first-cycle thesis can escalate immediately, the worst
// case is bounded at 2 cycles, and every agent runs with reasoning_effort
// "minimal" (or "low" for the Synthesizer's structured output) so gpt-5-mini
// stops burning the entire wall-clock on hidden reasoning. SWING is the
// pre-existing "thoroughness" cadence for slower setups where it's fine to
// sit through 3-4 full debate rounds before locking in a thesis.
type SpeedMode = "scalp" | "swing";
type ReasoningEffort = "minimal" | "low" | "medium" | "high";

type CycleConfig = {
  minEscalateCycle: number;
  maxCyclesPerRun: number;
  // Per-agent reasoning_effort. Strategist/Adversary/Observer/Queen use
  // `effort`; Synthesizer's structured-output JSON call gets `synthEffort`
  // because its payload is more complex and benefits from a touch more
  // thinking than the others.
  effort?: ReasoningEffort;
  synthEffort?: ReasoningEffort;
};

function configForMode(mode: SpeedMode): CycleConfig {
  if (mode === "swing") {
    // Old behavior — full thoroughness, no reasoning_effort cap.
    return {
      minEscalateCycle: 3,
      maxCyclesPerRun: 4,
      effort: undefined,
      synthEffort: undefined,
    };
  }
  return {
    minEscalateCycle: 1,
    maxCyclesPerRun: 2,
    effort: "minimal",
    synthEffort: "low",
  };
}

// Compose the agent's system prompt with the optional market-context block
// prepended verbatim. When no symbol is set the block is empty and the prompt
// is unchanged from its pre-Phase-3 form.
function withMarketContext(systemPrompt: string, marketContextBlock: string): string {
  if (!marketContextBlock) return systemPrompt;
  return `${marketContextBlock}\n\n${systemPrompt}`;
}

// Emit a chart_annotation event AND persist the annotations onto the packet
// row so a page reload can replay the chart state. Defensive: bad annotations
// are dropped silently.
async function emitAnnotationsForPacket(
  packetId: number,
  missionId: number,
  cycle: number,
  source: "synthesizer" | "queen",
  raw: unknown,
  sendEvent: SendEvent,
): Promise<void> {
  const parsed = parseAnnotations(raw);
  if (!parsed) return;
  if (parsed.markers.length === 0 && parsed.priceLines.length === 0) return;

  await db
    .update(reasoningPackets)
    .set({ annotations: parsed })
    .where(eq(reasoningPackets.id, packetId))
    .catch((err) => logger.warn({ err, packetId }, "failed to persist annotations"));

  sendEvent({
    type: "chart_annotation",
    data: { packetId, missionId, cycle, source, annotations: parsed },
  });
}

// gpt-5-mini is a reasoning model — when its hidden reasoning consumes the
// entire token budget the visible content comes back empty, surfacing as
// "(empty response)" in the UI and wasting an entire cycle. This helper makes
// one retry with a doubled budget on empty/whitespace content, sums the usage
// across attempts so cost accounting stays accurate, and returns a non-empty
// fallback marker the caller can substitute with a meaningful placeholder so
// the operator always sees what happened instead of a blank packet.
// Apply reasoning_effort onto a chat-completions params object. The OpenAI SDK
// types accept it but vary by version, so we widen via a Record cast to keep
// the call sites clean. Returns a NEW params object (no mutation).
function withReasoningEffort(
  params: ChatCompletionCreateParamsNonStreaming,
  effort: ReasoningEffort | undefined,
): ChatCompletionCreateParamsNonStreaming {
  if (!effort) return params;
  return { ...(params as unknown as Record<string, unknown>), reasoning_effort: effort } as ChatCompletionCreateParamsNonStreaming;
}

async function invokeChatWithEmptyRetry(opts: {
  agent: string;
  missionId: number;
  cycle: number;
  params: ChatCompletionCreateParamsNonStreaming;
}): Promise<{ content: string; usage: OpenAIUsage; empty: boolean; finishReason?: string }> {
  const { agent, missionId, cycle, params } = opts;
  const sumUsage = (a: OpenAIUsage, b: OpenAIUsage): OpenAIUsage => ({
    prompt_tokens: (a?.prompt_tokens ?? 0) + (b?.prompt_tokens ?? 0),
    completion_tokens: (a?.completion_tokens ?? 0) + (b?.completion_tokens ?? 0),
    completion_tokens_details: {
      reasoning_tokens:
        (a?.completion_tokens_details?.reasoning_tokens ?? 0) +
        (b?.completion_tokens_details?.reasoning_tokens ?? 0),
    },
  });

  const first = await openai.chat.completions.create(params);
  const c1 = (first.choices[0]?.message?.content ?? "").trim();
  const u1 = first.usage as OpenAIUsage;
  if (c1) return { content: c1, usage: u1, empty: false };

  const baseTokens = params.max_completion_tokens ?? 4000;
  logger.warn(
    {
      agent,
      missionId,
      cycle,
      finishReason: first.choices[0]?.finish_reason,
      usage: first.usage,
      retryTokens: baseTokens * 2,
    },
    "agent returned empty content; retrying with doubled token budget",
  );

  const retryParams = { ...params, max_completion_tokens: baseTokens * 2 };
  const second = await openai.chat.completions.create(retryParams);
  const c2 = (second.choices[0]?.message?.content ?? "").trim();
  const combined = sumUsage(u1, second.usage as OpenAIUsage);
  if (c2) return { content: c2, usage: combined, empty: false };

  logger.error(
    {
      agent,
      missionId,
      cycle,
      finishReason: second.choices[0]?.finish_reason,
      usage: second.usage,
    },
    "agent returned empty content twice; caller will substitute fallback text",
  );
  return {
    content: "",
    usage: combined,
    empty: true,
    finishReason: second.choices[0]?.finish_reason ?? undefined,
  };
}

// ─── Worker Agents (Multi-Agent Debate) ──────────────────────────────────────
async function workerStrategist(
  primeObjective: string,
  cycle: number,
  previousVerdicts: string[],
  thesisLock: string | null,
  queenGuidance: string | null,
  priorRatifiedProposal: string | null,
  missionId: number,
  marketContextBlock: string,
  cfg: CycleConfig,
  sendEvent: SendEvent
): Promise<string> {
  const systemPrompt = withMarketContext(`You are WORKER-STRATEGIST inside MOTHERSHIP — a Hyperliquid perpetuals trading desk. Your only job is to OPEN A CONCRETE TRADE THESIS for the instrument named in the Prime Objective. Not a plan to research one. Not a methodology. The thesis itself, ready for an operator to act on.

Output exactly these sections, in this order, using these literal headers:

=== TRADE THESIS ===
- Symbol: <perp ticker>
- Bias: <LONG | SHORT | FLAT> — one sentence justification anchored to recent price structure.
- Entry zone: <numeric range in USD>
- Invalidation / stop: <numeric price> — must sit on the structurally wrong side of entry.
- Take-profit ladder: <TP1, TP2 (optional TP3) with numeric prices and rough scale-out %>
- Sizing assumption: <% account risk per trade, e.g. 0.5–1%>
- R:R at TP1: <ratio>

=== HTF LEVEL ANCHORS ===
Every numeric trade level you emit (entry, stop, TP1, TP2) MUST be anchored to a real higher-timeframe structural level taken from the MARKET CONTEXT block above. For each level, write one bullet of the form:
  - <Level name> @ <price> ← <timeframe> <kind> <value> (e.g. "Stop @ 76,540 ← 4h swingHigh 76,540")
Pull anchors from these fields under timeframes.<tf>: swingHighs, swingLows, rangeHigh, rangeLow, priorDayHigh, priorDayLow. Prefer 1h / 4h / 1d anchors for stops & TPs; 5m / 15m anchors are acceptable for tactical entries.

=== ON-CHART EVIDENCE ===
Exactly 2 bullets, each citing a specific candle timestamp from the 5m or 15m bars array (or a swing pivot from the HTF summaries). Reference funding rate, open interest, 24h change, the per-timeframe trend bias, or ATR ONLY if they support the bias. No generic "price is trending" filler.

Hard rules:
- All prices in USD quote terms. Numeric, no ranges of "around X".
- Stop must be on the opposite side of entry from the take-profits. R:R at TP1 must be ≥ 1.0.
- Every named price level must round-trip to a value present in the HTF summaries (within ATR-scaled tolerance). Inventing levels not visible in the MARKET CONTEXT block is forbidden.
- All targets must be reachable from the most recent close (no 50%-away targets).
- No prose about "we will analyze", "we will monitor", "consider exploring". Emit the thesis.
- No email, no list, no compliance language, no methodology.
- If the Prime Objective does NOT name a specific perp ticker AND no MARKET CONTEXT block is present, do NOT invent a symbol or fabricate prices. Instead emit Symbol: UNSPECIFIED, Bias: FLAT, leave numeric fields as "n/a — awaiting symbol", and use the ON-CHART EVIDENCE section to ask the operator (one bullet) which instrument to analyze.

${thesisLock ? `Operating Thesis Lock (must comply with bias and direction): ${thesisLock}` : ""}
${queenGuidance ? `\n=== PRIORITY QUEEN GUIDANCE ===\n${queenGuidance}\nFold this directly into the thesis.\n=================================\n` : ""}
${priorRatifiedProposal ? `\n=== REFINEMENT MODE — PRIOR RATIFIED THESIS ===\nThe previous cycle already produced a ratified Synthesizer thesis. You are NOT starting over. Keep the same Symbol and Bias unless market context has structurally shifted (e.g. invalidation level was breached). Tighten levels, sharpen evidence, address observer gaps. Do NOT flip direction.\n\n${priorRatifiedProposal}\n=================================================\n` : ""}
${previousVerdicts.length > 0 ? `\nObserver feedback from prior cycles (fix these specific gaps in the thesis):\n${previousVerdicts.slice(-3).join("\n")}\n` : ""}

Output ONLY the three sections above (TRADE THESIS, HTF LEVEL ANCHORS, ON-CHART EVIDENCE), in that order. No preamble, no closing remarks.`, marketContextBlock);

  const startedAt = Date.now();
  const result = await invokeChatWithEmptyRetry({
    agent: "STRATEGIST",
    missionId,
    cycle,
    params: withReasoningEffort({
      model: "gpt-5-mini",
      max_completion_tokens: 4000,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Prime Objective: "${primeObjective}"\n\nCycle ${cycle} — open the debate with your strategic proposal.` }
      ],
    }, cfg.effort),
  });
  const durationMs = Date.now() - startedAt;

  const proposal = result.empty
    ? `[STRATEGIST: model returned no content after retry (finish_reason=${result.finishReason ?? "unknown"}). The reasoning budget was exhausted before any thesis was emitted. Skipping this cycle's proposal — the next cycle will retry from scratch.]`
    : result.content;

  const packet = await db.insert(reasoningPackets).values({
    missionId,
    cycle,
    agentRole: "worker",
    reasoning: `Strategist (opening) — Cycle ${cycle}`,
    proposal,
    durationMs,
  }).returning();

  await recordCallCost({
    missionId,
    packetId: packet[0].id,
    cycle,
    agent: "STRATEGIST",
    usage: result.usage,
    durationMs,
    sendEvent,
  });

  sendEvent({
    type: "worker_proposal",
    data: {
      packetId: packet[0].id,
      cycle,
      proposal,
      reasoning: `Strategist (opening) — Cycle ${cycle}`,
      agentName: "STRATEGIST",
      agentRole: "worker",
      stage: "open",
      durationMs,
    }
  });

  return proposal;
}

async function workerAdversary(
  primeObjective: string,
  cycle: number,
  strategistProposal: string,
  priorRatifiedProposal: string | null,
  missionId: number,
  marketContextBlock: string,
  cfg: CycleConfig,
  sendEvent: SendEvent
): Promise<string> {
  const refinementClause = priorRatifiedProposal
    ? `\n\n=== REFINEMENT MODE ===\nA prior cycle already produced a ratified thesis (below). The Strategist is REFINING it, not starting over. Critique only the DELTA — what changed vs the prior thesis, and whether the changes survived your structural checks. Do NOT re-litigate the symbol or bias choice unless the prior invalidation was breached.\n\nPRIOR RATIFIED THESIS:\n${priorRatifiedProposal}\n=========================\n`
    : "";
  const systemPrompt = withMarketContext(`You are WORKER-ADVERSARY inside MOTHERSHIP — a perp trading desk. The Strategist just opened a trade thesis. Your only job is to attack it on TRADE QUALITY grounds and force the Synthesizer to harden it.${refinementClause}

Attack vectors (cover the ones that apply, ignore the rest):
1. HTF anchoring — Does the Strategist's stop and each TP cite a real level in the MARKET CONTEXT timeframes block (swingHighs/swingLows/rangeHigh/rangeLow/priorDayHigh/Low)? If a level is invented or anchored only to 5m noise where a stronger 1h/4h level sits nearby, name the better anchor with timeframe + value.
2. HTF trend conflict — Does the bias fight the trend on a higher timeframe (e.g. LONG while 4h.trend = down)? Quote the conflicting timeframe's trend tag.
3. Level coherence — Is the entry zone inside meaningful structure (range edge, prior swing, liquidity pocket)? Quote the relevant HTF level it should sit on.
4. Stop placement — Is the invalidation on the structurally wrong side, far enough to survive normal noise (compare against the relevant timeframe's atr), but tight enough to keep R:R sane? If recent 5m or 15m bars have wicks larger than the stop distance, quote the wick.
5. Take-profit realism — Are TPs reachable from the current mark within the implied holding period? Are they parked just past obvious magnets (HTF swings, prior-day H/L, round numbers) where they'll fill, or just inside them where they'll miss?
6. Funding / OI / 24h-change conflict — Does the bias fight a strongly skewed funding rate or a recent OI surge in the opposite direction? Quote the number.
7. Sizing & R:R sanity — Is the % risk reasonable for the entry-to-stop distance? Is R:R at TP1 actually ≥ 1.0 by the numbers?

Do NOT critique research methodology, sourcing, compliance, or wording style. Attack only the trade itself, with numbers and HTF citations.

Format: 2–3 sharp sentences, each quoting a specific number, candle timestamp, or HTF level tag (e.g. "1h swingHigh 76,540"). End with one concrete counter-suggestion that itself cites a HTF anchor ("move stop from X to Y, the 4h swingHigh, because…").`, marketContextBlock);

  const startedAt = Date.now();
  const result = await invokeChatWithEmptyRetry({
    agent: "ADVERSARY",
    missionId,
    cycle,
    params: withReasoningEffort({
      model: "gpt-5-mini",
      max_completion_tokens: 3000,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Prime Objective: "${primeObjective}"\nCycle ${cycle}\n\nStrategist proposal to attack:\n"${strategistProposal}"\n\nDeliver your critique now.` }
      ],
    }, cfg.effort),
  });
  const durationMs = Date.now() - startedAt;

  const critique = result.empty
    ? `[ADVERSARY: model returned no critique after retry (finish_reason=${result.finishReason ?? "unknown"}). Treating this as a no-op critique so the Synthesizer still runs on the Strategist's draft.]`
    : result.content;

  const packet = await db.insert(reasoningPackets).values({
    missionId,
    cycle,
    agentRole: "worker",
    reasoning: `Adversary (critique) — Cycle ${cycle}`,
    proposal: critique,
    durationMs,
  }).returning();

  await recordCallCost({
    missionId,
    packetId: packet[0].id,
    cycle,
    agent: "ADVERSARY",
    usage: result.usage,
    durationMs,
    sendEvent,
  });

  await db.insert(vetoes).values({
    missionId,
    cycle,
    vetoedBy: "adversary",
    reason: critique,
    proposalSummary: strategistProposal.substring(0, 500),
  });

  sendEvent({
    type: "worker_proposal",
    data: {
      packetId: packet[0].id,
      cycle,
      proposal: critique,
      reasoning: `Adversary (critique) — Cycle ${cycle}`,
      agentName: "ADVERSARY",
      agentRole: "worker",
      stage: "critique",
      durationMs,
    }
  });

  return critique;
}

async function workerSynthesizer(
  primeObjective: string,
  cycle: number,
  strategistProposal: string,
  adversaryCritique: string,
  thesisLock: string | null,
  queenGuidance: string | null,
  missionId: number,
  marketContextBlock: string,
  marketCtx: MarketContext | null,
  cfg: CycleConfig,
  sendEvent: SendEvent
): Promise<string> {
  const baseSystem = `You are WORKER-SYNTHESIZER inside MOTHERSHIP — a perp trading desk. Produce the FINAL, RATIFIED TRADE THESIS by folding the Strategist's draft and the Adversary's critique into one tightened deliverable. The output IS the trade, ready for the operator to size and submit.

Output exactly these sections, in this order, using these literal headers:

=== TRADE THESIS ===
- Symbol: <perp ticker>
- Bias: <LONG | SHORT | FLAT> — one sentence justification.
- Entry zone: <numeric USD range>
- Invalidation / stop: <numeric USD>
- Take-profit ladder: <TP1, TP2, optional TP3 with numeric prices and scale-out %>
- Sizing: <% account risk per trade>
- R:R at TP1: <ratio>

=== HTF LEVEL ANCHORS ===
For EVERY price level above (entry zone endpoints, stop, TP1, TP2, optional TP3) emit one bullet of the form:
  - <Level name> @ <price> ← <timeframe> <kind> <value> (e.g. "TP2 @ 78,200 ← 1d priorDayHigh 78,210")
Pull anchors from the timeframes.<tf> entries in MARKET CONTEXT: swingHighs, swingLows, rangeHigh, rangeLow, priorDayHigh, priorDayLow. Stops & TPs should prefer 1h/4h/1d anchors; entries may use 5m/15m. If a level cannot be anchored, drop or move it — do not invent levels.

=== ADVERSARY ADJUSTMENTS ===
2–4 bullets naming each Adversary objection and the specific change you made (e.g. "Stop moved from 76,200 → 76,350 to clear the 4h swingHigh and the 02:15 wick"). If you rejected an objection, say which and why in one sentence, citing the HTF anchor that makes it safe.

=== ON-CHART EVIDENCE ===
2–4 bullets, each anchored to a specific candle timestamp from the 5m or 15m bars array, or to a named HTF swing/level. Tie each evidence point to bias, entry, stop, or TP.

Hard rules:
- All prices numeric, in USD quote terms.
- Stop must be on the opposite side of entry from TPs. R:R at TP1 ≥ 1.0.
- Every named price MUST round-trip to a value present in the HTF summaries (within ATR-scaled tolerance) — the Observer will check this and dock alignment for unmatched prices.
- Every named price must be reachable from the most recent close.
- No emails, no lists of people or companies, no compliance copy, no methodology — this terminal trades perps and nothing else.
- No "we will", no closing remarks. The markdown body must contain exactly the four sections defined above (TRADE THESIS, HTF LEVEL ANCHORS, ADVERSARY ADJUSTMENTS, ON-CHART EVIDENCE), in that order, and nothing else.
- If the Strategist's draft already used Symbol: UNSPECIFIED / Bias: FLAT (no instrument resolvable), keep that posture: do not invent a ticker or prices. Instead emit Symbol: UNSPECIFIED, Bias: FLAT, leave numeric fields as "n/a — awaiting symbol", and use ADVERSARY ADJUSTMENTS to summarize the unresolved ambiguity for the operator.

${thesisLock ? `Operating Thesis Lock (must comply with bias and direction): ${thesisLock}` : ""}
${queenGuidance ? `\nPRIORITY QUEEN GUIDANCE: ${queenGuidance}` : ""}`;

  const systemPrompt = withMarketContext(
    marketCtx
      ? `${baseSystem}\n\n=== STRUCTURED OUTPUT REQUIRED ===\nReturn a JSON object with two keys:\n  - "proposal": a STRING containing exactly the four markdown sections defined above, in this order: === TRADE THESIS ===, === HTF LEVEL ANCHORS ===, === ADVERSARY ADJUSTMENTS ===, === ON-CHART EVIDENCE ===. Nothing else. The markdown structure rules above apply to the contents of this string.\n  - "annotations": an object with "markers" (≤8) and "priceLines" (≤4) that visualize the key levels named in the thesis on the candlestick chart of ${marketCtx.symbol}.\nMarker timeUtcSec MUST be drawn from one of the bars arrays in the MARKET CONTEXT block (timeframes.5m.bars or timeframes.15m.bars are best for execution-level markers; omit if you cannot anchor to a real candle). Price values must be in USD quote terms. Use kind="entry"/"stop"/"take_profit" for trade levels and "signal"/"note" otherwise. Keep annotation text under 80 chars.`
      : baseSystem,
    marketContextBlock,
  );

  const messages = [
    { role: "system" as const, content: systemPrompt },
    {
      role: "user" as const,
      content: `Prime Objective: "${primeObjective}"\nCycle ${cycle}\n\nStrategist's opening:\n"${strategistProposal}"\n\nAdversary's critique:\n"${adversaryCritique}"\n\nSynthesize the final ratified proposal now.`,
    },
  ];

  const startedAt = Date.now();
  let synthesis: string = "";
  let rawAnnotations: unknown = null;
  // Synthesizer can make 1 or 2 LLM calls per cycle (structured + fallback). Sum
  // their usage so the packet row reflects total tokens spent producing it.
  let aggregatedUsage: { prompt_tokens: number; completion_tokens: number; completion_tokens_details: { reasoning_tokens: number } } = {
    prompt_tokens: 0,
    completion_tokens: 0,
    completion_tokens_details: { reasoning_tokens: 0 },
  };
  const accumulateUsage = (u: OpenAIUsage) => {
    aggregatedUsage.prompt_tokens += u?.prompt_tokens ?? 0;
    aggregatedUsage.completion_tokens += u?.completion_tokens ?? 0;
    aggregatedUsage.completion_tokens_details.reasoning_tokens +=
      u?.completion_tokens_details?.reasoning_tokens ?? 0;
  };

  if (marketCtx) {
    // Structured-output path: ratified proposal + chart annotations in one call.
    // gpt-5-mini is a reasoning model, so max_completion_tokens must cover both
    // invisible reasoning tokens AND the JSON payload. 12000 leaves comfortable
    // headroom; previously 4000 was getting eaten by reasoning and truncating
    // the JSON mid-stream, producing empty/unparseable content.
    const response = await openai.chat.completions.create(withReasoningEffort({
      model: "gpt-5-mini",
      max_completion_tokens: 8000,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: structuredAnnotationSchema("proposal"),
      },
    }, cfg.synthEffort));
    accumulateUsage(response.usage as OpenAIUsage);
    const choice = response.choices[0];
    const raw = choice?.message?.content ?? "";
    let structuredFailed = false;
    let failureReason = "";
    try {
      const parsed = JSON.parse(raw) as { proposal?: string; annotations?: unknown };
      const proposalText = (parsed.proposal ?? "").trim();
      if (proposalText) {
        synthesis = proposalText;
        rawAnnotations = parsed.annotations ?? null;
      } else {
        structuredFailed = true;
        failureReason = "empty_proposal";
      }
    } catch {
      structuredFailed = true;
      failureReason = "json_parse_error";
    }

    if (structuredFailed) {
      logger.warn(
        {
          missionId,
          cycle,
          reason: failureReason,
          finishReason: choice?.finish_reason,
          usage: response.usage,
          rawPreview: raw.slice(0, 300),
        },
        "synthesizer structured output failed; retrying without json_schema",
      );

      // Graceful no-annotations retry: same prompt, no schema, plain text.
      // The operator gets the ratified artifact even when annotations are lost
      // for this cycle. Cycle supersession on the client handles missing
      // annotations correctly (the next successful cycle will repopulate).
      const fallbackResult = await invokeChatWithEmptyRetry({
        agent: "SYNTHESIZER",
        missionId,
        cycle,
        params: withReasoningEffort({
          model: "gpt-5-mini",
          max_completion_tokens: 4000,
          messages,
        }, cfg.synthEffort),
      });
      accumulateUsage(fallbackResult.usage);
      synthesis = fallbackResult.empty
        ? `[SYNTHESIZER: model returned no content after retry (finish_reason=${fallbackResult.finishReason ?? "unknown"}). Falling back to the Strategist's draft so the operator still sees something actionable.]\n\n${strategistProposal}`
        : fallbackResult.content;
      rawAnnotations = null;
    }
  } else {
    const result = await invokeChatWithEmptyRetry({
      agent: "SYNTHESIZER",
      missionId,
      cycle,
      params: withReasoningEffort({
        model: "gpt-5-mini",
        max_completion_tokens: 4000,
        messages,
      }, cfg.synthEffort),
    });
    accumulateUsage(result.usage);
    synthesis = result.empty
      ? `[SYNTHESIZER: model returned no content after retry (finish_reason=${result.finishReason ?? "unknown"}). Falling back to the Strategist's draft so the operator still sees something actionable.]\n\n${strategistProposal}`
      : result.content;
  }

  const durationMs = Date.now() - startedAt;

  const packet = await db.insert(reasoningPackets).values({
    missionId,
    cycle,
    agentRole: "worker",
    reasoning: `Synthesizer (ratified) — Cycle ${cycle}`,
    proposal: synthesis,
    durationMs,
  }).returning();

  await recordCallCost({
    missionId,
    packetId: packet[0].id,
    cycle,
    agent: "SYNTHESIZER",
    usage: aggregatedUsage,
    durationMs,
    sendEvent,
  });

  sendEvent({
    type: "worker_proposal",
    data: {
      packetId: packet[0].id,
      cycle,
      proposal: synthesis,
      reasoning: `Synthesizer (ratified) — Cycle ${cycle}`,
      agentName: "SYNTHESIZER",
      agentRole: "worker",
      stage: "synthesis",
      durationMs,
    }
  });

  if (rawAnnotations) {
    await emitAnnotationsForPacket(packet[0].id, missionId, cycle, "synthesizer", rawAnnotations, sendEvent);
  }

  return synthesis;
}

// ─── Observer Node ────────────────────────────────────────────────────────────
async function observerNode(
  primeObjective: string,
  proposal: string,
  cycle: number,
  rules: string[],
  missionId: number,
  marketContextBlock: string,
  marketCtx: MarketContext | null,
  cfg: CycleConfig,
  sendEvent: SendEvent
): Promise<{ verdict: "PASS" | "VETO" | "ESCALATE"; reason: string; alignmentScore: number }> {
  // Deterministic level-citation audit: parse labelled prices from the
  // proposal text and check that each one round-trips to a real HTF level.
  // Embedded into the Observer's system prompt so the LLM can dock points
  // for unmatched levels in a consistent way (instead of guessing).
  let levelReport = "";
  let unmatchedLevels = 0;
  if (marketCtx) {
    const v = validateLevelCitations(proposal, marketCtx);
    levelReport = v.report;
    // A "fault" is either a price that doesn't sit on any HTF level, OR an
    // explicit anchor claim whose <tf> <kind> <value> is not in the catalog.
    // Dedupe by price (rounded) so the same bad level can't be counted twice
    // — once via the price-proximity miss and again via the anchor-claim miss.
    const faultPrices = new Set<string>();
    for (const c of v.citations) {
      if (!c.nearest) faultPrices.add(c.price.toFixed(4));
    }
    for (const a of v.anchorClaims) {
      if (!a.matches) faultPrices.add(a.price.toFixed(4));
    }
    unmatchedLevels = faultPrices.size;
  }

  const systemPrompt = withMarketContext(`You are the OBSERVER NODE in MOTHERSHIP — the strict auditor of a perp trading desk's worker debate. You are auditing a TRADE THESIS against the Prime Objective, the Rules Engine, and the deterministic Level Validation Report below.

Rules Engine:
${rules.length > 0 ? rules.map((r, i) => `${i + 1}. ${r}`).join("\n") : "1. Thesis must address the symbol and bias requested in the Prime Objective\n2. Entry, stop, and take-profits must all be numeric USD prices\n3. Stop must sit on the opposite side of entry from take-profits\n4. R:R at TP1 must be ≥ 1.0\n5. Every named price must be reachable from the recent close (within ~10%)\n6. Every named price MUST round-trip to a real HTF structural level (swing, range, or prior-day H/L) within ATR-scaled tolerance"}

${levelReport ? `=== LEVEL VALIDATION REPORT (deterministic, computed from MARKET CONTEXT) ===\n${levelReport}\n=== END REPORT ===\n` : ""}
Trade-quality checklist (score each silently, then aggregate):
A. Completeness — Symbol, Bias, Entry zone, Stop, TP ladder, Sizing, and R:R at TP1 all present and numeric? (no placeholders)
B. HTF anchoring — Per the Level Validation Report above, BOTH the price-proximity check AND the anchor-claim check must clear. EACH ✗ from either check costs 0.10 alignment points. If 2 or more ✗ marks appear in total, the thesis cannot exceed 0.69. A false anchor claim (cited tf+kind+value not in the catalog) is treated identically to an un-anchored price.
C. Level coherence — Entry sits inside meaningful structure visible in the MARKET CONTEXT timeframes? Stop is on the right side and clears recent wick noise (compare to atr)?
D. Reachability — Every TP is achievable from the most recent close within a reasonable holding period? No 50%-away targets?
E. R:R sanity — TP1 reward ÷ entry-to-stop distance ≥ 1.0?
F. Adversary objections answered — Did the Synthesizer either fold each Adversary point in or explicitly reject it with a reason?

Scoring rubric (apply Level Validation penalty AFTER):
- 0.85+ = thesis is complete, numerically coherent, every named price matches a real HTF level, and every Adversary objection is resolved. Ready for the Queen to lock.
- 0.70–0.84 = thesis is complete but has a real trade-quality gap (one TP unrealistic, stop a bit tight vs ATR, an Adversary point dodged, ONE unmatched HTF level, evidence weak on one bullet).
- 0.50–0.69 = thesis is structurally incomplete OR contains a hard error (stop on wrong side, R:R < 1.0, ≥2 unmatched/fabricated price levels, mostly prose instead of numbers).
- below 0.50 = no usable thesis, or violates the Rules Engine.

Reward concrete numerical theses. Do not penalize for missing sourcing/methodology/compliance copy — that is explicitly out of scope for this terminal.

Your response MUST follow this exact format on three separate lines:
VERDICT: PASS
ALIGNMENT: 0.78
AUDIT: [2–4 sentences naming what is strong and what still falls short, quoting at least one specific price level from the thesis]

VERDICT rules:
- PASS = aligned but not yet decisive (score 0.50–0.84). Workers must continue debating.
- VETO = misaligned or violates rules (score below 0.50). Reject with feedback.
- ESCALATE = decisive consensus (score ≥ 0.85), AND only from cycle ${cfg.minEscalateCycle} onward. In any earlier cycle, even a perfect thesis must be returned as PASS so the debate completes at least one round of adversarial pressure before the Queen locks it. (Current minimum escalate cycle for this run: ${cfg.minEscalateCycle}.)
- If the thesis carries Symbol: UNSPECIFIED / Bias: FLAT because no instrument was named, score it 0.50 with VERDICT: PASS and use the AUDIT line to surface the ambiguity for the operator. Do not VETO purely for the missing symbol.`, marketContextBlock);

  const startedAt = Date.now();
  const result = await invokeChatWithEmptyRetry({
    agent: "OBSERVER",
    missionId,
    cycle,
    params: withReasoningEffort({
      model: "gpt-5-mini",
      max_completion_tokens: 4000,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Prime Objective: "${primeObjective}"\nCycle: ${cycle}\nFinal Synthesized Worker Proposal:\n"${proposal}"\n\nAudit this proposal now.`
        }
      ],
    }, cfg.effort),
  });
  const durationMs = Date.now() - startedAt;

  // Empty Observer output is treated as a hard VETO so the cycle is never
  // silently approved when the auditor failed to speak.
  const content = result.empty
    ? `VERDICT: VETO\nALIGNMENT: 0.00\nAUDIT: [OBSERVER: model returned no audit after retry (finish_reason=${result.finishReason ?? "unknown"}). Auto-vetoing this cycle so it is not silently approved.]`
    : result.content;

  const verdictMatch = content.match(/^VERDICT:\s*(PASS|VETO|ESCALATE)/im);
  const scoreMatch = content.match(/^ALIGNMENT:\s*([\d.]+)/im);
  const auditMatch = content.match(/^AUDIT:\s*(.+)/ims);

  let verdict = (verdictMatch?.[1]?.toUpperCase() as "PASS" | "VETO" | "ESCALATE") ?? "PASS";
  let alignmentScore = Math.min(1.0, Math.max(0.0, parseFloat(scoreMatch?.[1] ?? "0.7")));
  let reason = auditMatch?.[1]?.trim() ?? content;

  // Deterministic enforcement of the level-citation rubric — the LLM is
  // instructed to apply this penalty in its score, but we floor it in code
  // so unmatched HTF levels can never slip through silently. Each unmatched
  // level docks 0.10; ≥2 unmatched caps the score at 0.69 (must redebate).
  if (unmatchedLevels > 0) {
    const penalised = Math.max(0, alignmentScore - 0.10 * unmatchedLevels);
    const capped = unmatchedLevels >= 2 ? Math.min(penalised, 0.69) : penalised;
    if (capped < alignmentScore) {
      const note = ` [Level Validation: ${unmatchedLevels} unmatched HTF level(s); score floored from ${alignmentScore.toFixed(2)} to ${capped.toFixed(2)}.]`;
      reason = `${reason}${note}`;
      alignmentScore = capped;
    }
  }

  if (verdict === "ESCALATE" && (alignmentScore < ESCALATE_THRESHOLD || cycle < cfg.minEscalateCycle)) {
    verdict = "PASS";
  }
  if (verdict === "PASS" && alignmentScore >= ESCALATE_THRESHOLD && cycle >= cfg.minEscalateCycle) {
    verdict = "ESCALATE";
  }
  // Strict rubric consistency: any sub-0.50 score is a VETO regardless of
  // what the LLM said, including when that score is the result of the
  // post-LLM level-validation penalty above.
  if (alignmentScore < 0.5 && verdict !== "VETO") {
    verdict = "VETO";
  }

  const packet = await db.insert(reasoningPackets).values({
    missionId,
    cycle,
    agentRole: "observer",
    reasoning: reason,
    verdict,
    alignmentScore,
    durationMs,
  }).returning();

  await recordCallCost({
    missionId,
    packetId: packet[0].id,
    cycle,
    agent: "OBSERVER",
    usage: result.usage,
    durationMs,
    sendEvent,
  });

  if (verdict === "VETO") {
    await db.insert(vetoes).values({
      missionId,
      cycle,
      vetoedBy: "observer",
      reason,
      proposalSummary: proposal.substring(0, 300)
    });
  }

  sendEvent({
    type: "observer_audit",
    data: {
      packetId: packet[0].id,
      cycle,
      verdict,
      alignmentScore,
      reasoning: reason,
      agentRole: "observer",
      durationMs,
    }
  });

  return { verdict, reason, alignmentScore };
}

// ─── Queen Node (Checkpoint) ─────────────────────────────────────────────────
async function queenCheckpoint(
  primeObjective: string,
  proposal: string,
  cycle: number,
  alignmentScore: number,
  missionId: number,
  marketContextBlock: string,
  marketCtx: MarketContext | null,
  cfg: CycleConfig,
  sendEvent: SendEvent
): Promise<{ thesisLock: string }> {
  const baseSystem = `You are the QUEEN NODE in MOTHERSHIP. The Observer has CONFIRMED CONSENSUS on a Worker proposal (alignment ≥ 0.85).
Your role: synthesize that proposal into a definitive THESIS LOCK — a precise, sovereign directive that governs all future cycles. Once locked, it is immutable.
Respond with a single sentence beginning with: THESIS LOCK:`;

  const systemPrompt = withMarketContext(
    marketCtx
      ? `${baseSystem}\n\n=== STRUCTURED OUTPUT REQUIRED ===\nReturn an object with:\n  - "thesisLock": one sentence starting with "THESIS LOCK:" capturing the sovereign directive.\n  - "annotations": markers + priceLines that visualize the locked-in key levels on the ${marketCtx.symbol} chart. Promote the Synthesizer's most important entry/stop/target lines into priceLines so the operator sees them at-a-glance.`
      : baseSystem,
    marketContextBlock,
  );

  const messages = [
    { role: "system" as const, content: systemPrompt },
    {
      role: "user" as const,
      content: `Prime Objective: "${primeObjective}"\nCycle: ${cycle}\nAlignment Score: ${alignmentScore.toFixed(2)}\nRatified Proposal: "${proposal}"\n\nForge the Thesis Lock now.`,
    },
  ];

  const startedAt = Date.now();
  let thesisLock: string;
  let rawAnnotations: unknown = null;
  let queenUsage: OpenAIUsage = null;

  if (marketCtx) {
    const response = await openai.chat.completions.create(withReasoningEffort({
      model: "gpt-5-mini",
      max_completion_tokens: 2000,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: structuredAnnotationSchema("thesisLock"),
      },
    }, cfg.effort));
    queenUsage = response.usage as OpenAIUsage;
    const raw = response.choices[0]?.message?.content ?? "";
    try {
      const parsed = JSON.parse(raw) as { thesisLock?: string; annotations?: unknown };
      const tlRaw = (parsed.thesisLock ?? "").trim();
      const m = tlRaw.match(/THESIS LOCK:\s*(.+)/is);
      thesisLock = m ? m[1].trim() : tlRaw || "(empty thesis lock)";
      rawAnnotations = parsed.annotations ?? null;
    } catch {
      logger.warn({ missionId, cycle }, "queen structured output unparseable; treating as plain text");
      const m = raw.match(/THESIS LOCK:\s*(.+)/is);
      thesisLock = m ? m[1].trim() : raw.trim();
    }
  } else {
    const response = await openai.chat.completions.create(withReasoningEffort({
      model: "gpt-5-mini",
      max_completion_tokens: 2000,
      messages,
    }, cfg.effort));
    queenUsage = response.usage as OpenAIUsage;
    const content = (response.choices[0]?.message?.content ?? "").trim();
    const m = content.match(/THESIS LOCK:\s*(.+)/is);
    thesisLock = m ? m[1].trim() : content;
  }

  const durationMs = Date.now() - startedAt;

  const packet = await db.insert(reasoningPackets).values({
    missionId,
    cycle,
    agentRole: "queen",
    reasoning: `Queen synthesized Thesis Lock from ratified proposal (alignment: ${alignmentScore.toFixed(2)}).`,
    proposal: thesisLock,
    alignmentScore,
    durationMs,
  }).returning();

  await recordCallCost({
    missionId,
    packetId: packet[0].id,
    cycle,
    agent: "QUEEN",
    usage: queenUsage,
    durationMs,
    sendEvent,
  });

  sendEvent({
    type: "queen_checkpoint",
    data: {
      packetId: packet[0].id,
      cycle,
      thesisLock,
      alignmentScore,
      agentRole: "queen",
      awaitingDecision: true,
      durationMs,
    }
  });

  if (rawAnnotations) {
    await emitAnnotationsForPacket(packet[0].id, missionId, cycle, "queen", rawAnnotations, sendEvent);
  }

  return { thesisLock };
}

// ─── Queen Node (Final Verdict — always decisive, no deadlock) ───────────────
// Forces a committed CONFIRM / COUNTER / STAND_DOWN with a fully-shaped trade
// plan + chart annotations after the cycle loop exits without an ESCALATE.
// Replaces the legacy awaiting_intervention deadlock for normal flows.
// Build the FINAL_VERDICT JSON schema. Re-uses the same enum shape as
// structuredAnnotationSchema (MARKER_KINDS / MARKER_POSITIONS / MARKER_SHAPES /
// MARKER_COLORS / PRICE_LINE_KINDS / PRICE_LINE_COLORS) so the resulting
// annotations parse cleanly through parseAnnotations(). Inlined rather than
// reusing structuredAnnotationSchema because we also wrap verdict-specific
// fields (stance, tradePlan, etc.) in the same root object.
const FINAL_VERDICT_SCHEMA = {
  name: "queen_final_verdict",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      stance: { type: "string", enum: ["CONFIRM", "COUNTER", "STAND_DOWN"] },
      headline: { type: "string", maxLength: 200 },
      rationale: { type: "string", maxLength: 800 },
      tradePlan: {
        type: "object",
        additionalProperties: false,
        properties: {
          symbol: { type: "string", maxLength: 24 },
          bias: { type: "string", enum: ["LONG", "SHORT", "FLAT"] },
          entry: { type: "string", maxLength: 60 },
          stop: { type: "string", maxLength: 60 },
          tp1: { type: "string", maxLength: 60 },
          tp2: { type: "string", maxLength: 60 },
          sizing: { type: "string", maxLength: 60 },
          rr: { type: "string", maxLength: 40 },
        },
        required: ["symbol", "bias", "entry", "stop", "tp1", "tp2", "sizing", "rr"],
      },
      annotations: {
        type: "object",
        additionalProperties: false,
        properties: {
          markers: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: [...MARKER_KINDS] },
                timeUtcSec: { type: "integer", minimum: 0 },
                position: { type: "string", enum: [...MARKER_POSITIONS] },
                shape: { type: "string", enum: [...MARKER_SHAPES] },
                color: { type: "string", enum: [...MARKER_COLORS] },
                text: { type: "string", maxLength: 80 },
              },
              required: ["kind", "timeUtcSec", "position", "shape", "color", "text"],
            },
          },
          priceLines: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: [...PRICE_LINE_KINDS] },
                price: { type: "number" },
                color: { type: "string", enum: [...PRICE_LINE_COLORS] },
                label: { type: "string", maxLength: 40 },
              },
              required: ["kind", "price", "color", "label"],
            },
          },
        },
        required: ["markers", "priceLines"],
      },
      // Adaptive-timing fields. Queen MUST set selectedTimeframe explicitly
      // (defaults to the originalTimeframe in the timing signal). When she
      // promotes due to debate latency / stale entry, promotionReason is
      // one sentence explaining the bump. When she re-anchors entry/stop/
      // TPs to a different liquidity pocket than the ratified proposal
      // because the original was stale, reanchorReason is one sentence
      // describing the new anchor. Both reasons are empty strings when not
      // applicable. See queenFinalVerdict() for the full prompt contract.
      selectedTimeframe: { type: "string", enum: [...HTF_TIMEFRAMES] },
      promotionReason: { type: "string", maxLength: 240 },
      reanchorReason: { type: "string", maxLength: 240 },
    },
    required: [
      "stance", "headline", "rationale", "tradePlan", "annotations",
      "selectedTimeframe", "promotionReason", "reanchorReason",
    ],
  },
} as const;

type FinalVerdictPayload = {
  stance: "CONFIRM" | "COUNTER" | "STAND_DOWN";
  headline: string;
  rationale: string;
  tradePlan: {
    symbol: string; bias: "LONG" | "SHORT" | "FLAT";
    entry: string; stop: string; tp1: string; tp2: string;
    sizing: string; rr: string;
  };
  annotations: unknown;
  selectedTimeframe: string;
  promotionReason: string;
  reanchorReason: string;
};

// ─── Adaptive timing helpers ────────────────────────────────────────────────
//
// MSN-016 demonstrated the failure mode this addresses: the debate ran ~90s,
// price drifted past the original 5m entry band, and the Queen Final Verdict
// was forced into STAND_DOWN purely because of debate latency rather than
// any change in trade thesis. We now compute a timing/staleness signal at
// the Queen step and let her promote to a higher timeframe (5m → 15m → 1h)
// and/or re-anchor entry/stop/TPs to the next liquidity pocket instead of
// emitting a stale STAND_DOWN.

const SCALP_LATENCY_BUDGET_SEC = 75; // ~1/4 of a 5m bar — leaves room before next bar prints
// Trigger adaptation as we APPROACH the budget, not after exceeding it. At 80%
// of budget the Queen still has headroom to compute & ack a promoted plan
// before the next bar prints — waiting until we're already over guarantees
// we miss it. Per code review on Task #35.
const LATENCY_PRESSURE_FRACTION = 0.8;
const SCALP_BASE_TIMEFRAME: HtfTimeframe = "5m";
const SWING_BASE_TIMEFRAME: HtfTimeframe = "1h";

type TimingSignal = {
  timingPressured: boolean;
  entryStale: boolean;
  elapsedSec: number;
  latencyBudgetSec: number;
  markPrice: number;
  proposedEntryLow: number | null;
  proposedEntryHigh: number | null;
  originalTimeframe: HtfTimeframe;
  suggestedTimeframe: HtfTimeframe;
};

function nextHigherTimeframe(tf: HtfTimeframe): HtfTimeframe {
  const idx = HTF_TIMEFRAMES.indexOf(tf);
  if (idx < 0 || idx >= HTF_TIMEFRAMES.length - 1) return tf;
  return HTF_TIMEFRAMES[idx + 1];
}

// Best-effort parse of the ratified proposal's "Entry" or "Entry zone" line.
// Returns either a single price (low===high) or a range. Used only to detect
// staleness vs the current mark; if parsing fails we treat the band as
// unknown and skip the staleness check (no false positives).
function parseEntryBand(proposal: string): { low: number; high: number } | null {
  const m = proposal.match(/Entry(?:\s+zone)?\s*[:\-]\s*([0-9][0-9,]*\.?[0-9]*)(?:\s*[–-]\s*([0-9][0-9,]*\.?[0-9]*))?/i);
  if (!m) return null;
  const a = parseFloat(m[1].replace(/,/g, ""));
  const b = m[2] ? parseFloat(m[2].replace(/,/g, "")) : NaN;
  if (!Number.isFinite(a)) return null;
  if (Number.isFinite(b)) return { low: Math.min(a, b), high: Math.max(a, b) };
  return { low: a, high: a };
}

function assessTimingPressure(args: {
  startedAt: number;
  ratifiedProposal: string | null;
  marketCtx: MarketContext | null;
  speedMode: SpeedMode;
}): TimingSignal {
  const { startedAt, ratifiedProposal, marketCtx, speedMode } = args;
  const elapsedSec = (Date.now() - startedAt) / 1000;
  const latencyBudgetSec = speedMode === "scalp"
    ? SCALP_LATENCY_BUDGET_SEC
    : Number.POSITIVE_INFINITY;
  const originalTimeframe: HtfTimeframe =
    speedMode === "scalp" ? SCALP_BASE_TIMEFRAME : SWING_BASE_TIMEFRAME;
  const markPrice = marketCtx?.snapshot.markPrice ?? 0;
  const band = ratifiedProposal ? parseEntryBand(ratifiedProposal) : null;
  // Tolerance for the staleness check: 0.2% of mark, or 0.2 * 5m ATR if larger.
  // We want to flag "price has clearly left the entry band" — not "drifted by
  // a tick". Same idea as the level-citation tolerance, just tighter.
  const atr5m = marketCtx?.summaries["5m"]?.atr ?? 0;
  const tol = Math.max(markPrice * 0.002, atr5m * 0.2);
  let entryStale = false;
  if (band && markPrice > 0) {
    entryStale = markPrice < band.low - tol || markPrice > band.high + tol;
  }
  const timingPressured = Number.isFinite(latencyBudgetSec)
    && elapsedSec >= latencyBudgetSec * LATENCY_PRESSURE_FRACTION;
  const suggestedTimeframe = (timingPressured || entryStale)
    ? nextHigherTimeframe(originalTimeframe)
    : originalTimeframe;
  return {
    timingPressured,
    entryStale,
    elapsedSec,
    latencyBudgetSec,
    markPrice,
    proposedEntryLow: band?.low ?? null,
    proposedEntryHigh: band?.high ?? null,
    originalTimeframe,
    suggestedTimeframe,
  };
}

function renderTimingSignalBlock(t: TimingSignal): string {
  const lines: string[] = [];
  lines.push("=== TIMING & FRESHNESS SIGNAL ===");
  lines.push(`- elapsedSec: ${t.elapsedSec.toFixed(1)} (budget ${Number.isFinite(t.latencyBudgetSec) ? t.latencyBudgetSec.toFixed(0) : "∞"})`);
  lines.push(`- timingPressured: ${t.timingPressured}`);
  lines.push(`- markPrice: ${t.markPrice}`);
  if (t.proposedEntryLow != null && t.proposedEntryHigh != null) {
    const band = t.proposedEntryLow === t.proposedEntryHigh
      ? `${t.proposedEntryLow}`
      : `${t.proposedEntryLow}–${t.proposedEntryHigh}`;
    lines.push(`- proposedEntryBand: ${band}`);
  } else {
    lines.push("- proposedEntryBand: (could not parse from ratified proposal)");
  }
  lines.push(`- entryStale: ${t.entryStale}`);
  lines.push(`- originalTimeframe: ${t.originalTimeframe}`);
  lines.push(`- suggestedTimeframe (if you promote): ${t.suggestedTimeframe}`);
  lines.push("");
  if (t.timingPressured || t.entryStale) {
    lines.push("ADAPTIVE INSTRUCTION: the original entry plan is at risk of being stale — debate ran long and/or current mark has crossed the original entry band.");
    lines.push(`Prefer PROMOTING selectedTimeframe to "${t.suggestedTimeframe}" (or higher, if its structural levels also no longer bracket markPrice) AND/OR RE-ANCHORING entry/stop/TPs to the next liquidity pocket on the selected timeframe — the next swingHigh/swingLow / range edge / priorDay level reachable from markPrice in your bias direction.`);
    lines.push("Only emit STAND_DOWN if no anchor is reachable from the current mark under the bias.");
    lines.push("When you promote, set promotionReason to ONE concise sentence (e.g. \"promoted 5m → 15m: debate took 92s and the 5m entry 76,000–76,120 was crossed by current mark 75,890\").");
    lines.push("When entry/stop/TPs differ from the ratified proposal because the original was stale (not a routine COUNTER), set reanchorReason to ONE concise sentence describing the new anchor and why.");
  } else {
    lines.push("No timing pressure. Use the originalTimeframe as selectedTimeframe; leave promotionReason and reanchorReason as empty strings.");
  }
  lines.push("=== END TIMING & FRESHNESS SIGNAL ===");
  return lines.join("\n");
}

function renderFinalVerdictMarkdown(p: FinalVerdictPayload, cycle: number, alignment: number): string {
  const tp = p.tradePlan;
  return `=== FINAL VERDICT ===
- Stance: ${p.stance}
- Headline: ${p.headline}
- Decision cycle: ${cycle} (alignment ${alignment.toFixed(2)})
- Timeframe: ${p.selectedTimeframe}
- PromotionReason: ${p.promotionReason && p.promotionReason.trim() ? p.promotionReason.trim() : "(none)"}
- ReanchorReason: ${p.reanchorReason && p.reanchorReason.trim() ? p.reanchorReason.trim() : "(none)"}

=== TRADE PLAN ===
- Symbol: ${tp.symbol}
- Bias: ${tp.bias}
- Entry: ${tp.entry}
- Stop: ${tp.stop}
- TP1: ${tp.tp1}
- TP2: ${tp.tp2}
- Sizing: ${tp.sizing}
- R:R: ${tp.rr}

=== QUEEN RATIONALE ===
${p.rationale}`;
}

async function queenFinalVerdict(args: {
  primeObjective: string;
  ratifiedProposal: string;
  observerReason: string;
  alignmentScore: number;
  cycle: number;
  previousVerdicts: string[];
  marketContextBlock: string;
  marketCtx: MarketContext | null;
  missionId: number;
  cfg: CycleConfig;
  sendEvent: SendEvent;
  timingSignal: TimingSignal;
}): Promise<{ thesisLock: string; stance: FinalVerdictPayload["stance"] }> {
  const { primeObjective, ratifiedProposal, observerReason, alignmentScore, cycle, previousVerdicts, marketContextBlock, marketCtx, missionId, cfg, sendEvent, timingSignal } = args;

  const baseSystem = `You are the QUEEN NODE in MOTHERSHIP issuing a FINAL VERDICT. The Workers ran the maximum debate cycles without crossing the auto-escalate threshold (${ESCALATE_THRESHOLD}). You will NOT bounce this back to the workers and you will NOT loop. You commit NOW.

Pick exactly ONE stance:
- CONFIRM: the latest ratified Synthesizer proposal is good enough to execute as-is. Echo its symbol, bias, and levels into tradePlan verbatim (cleaned up and numeric).
- COUNTER: the symbol is right but at least one level needs adjustment. Issue a corrected tradePlan grounded in the MARKET CONTEXT block (anchor entry/stop/TP to real HTF levels).
- STAND_DOWN: there is no edge worth executing right now. Set bias to FLAT, sizing to "0%", and use entry/stop/tp fields to summarize the disqualifying conditions in plain language (e.g. "no setup — chop").

Hard rules:
- All numeric levels MUST be reachable from the most recent close in the MARKET CONTEXT block and anchored to a real HTF level (swingHigh/swingLow/range/priorDay). Do not invent prices.
- For CONFIRM/COUNTER: stop must sit on the structurally wrong side of entry, R:R at TP1 must be ≥ 1.0.
- The "annotations" object must visualize the trade plan on the chart: include priceLines for entry/stop/TP1/TP2 (use kind="entry"/"stop"/"take_profit"). Markers are optional.
- The "headline" is one decisive sentence the operator will see at the top of the verdict card.

Adaptive timing (NEW):
- The TIMING & FRESHNESS SIGNAL block in the user message tells you whether the original entry plan is still reachable from the current mark and whether debate latency has eaten the trade window.
- ALWAYS set selectedTimeframe explicitly. Default to the originalTimeframe when there is no timing pressure and the entry band still brackets the mark.
- When timingPressured OR entryStale is true, prefer to PROMOTE selectedTimeframe to a higher timeframe whose structural levels still bracket markPrice (5m → 15m → 1h, or higher), AND/OR RE-ANCHOR entry/stop/TPs to the next liquidity pocket on the selected timeframe (next swingHigh/swingLow / range edge / priorDay level reachable from the current mark in your bias direction). STAND_DOWN should only fire when no such anchor exists under the bias.
- When you promote the timeframe, fill promotionReason with one concise sentence; otherwise leave it as an empty string.
- When you re-anchor entry/stop/TPs to a different liquidity pocket than the ratified proposal because the original was stale (not a routine COUNTER), fill reanchorReason with one concise sentence; otherwise leave it as an empty string.
- All level rules above (HTF anchoring, stop on wrong side, R:R ≥ 1.0) still apply on the SELECTED timeframe.`;

  const systemPrompt = withMarketContext(baseSystem, marketContextBlock);

  const timingBlock = renderTimingSignalBlock(timingSignal);

  const userMsg = `PRIME OBJECTIVE: "${primeObjective}"

LATEST RATIFIED SYNTHESIZER PROPOSAL (cycle ${cycle}, alignment ${alignmentScore.toFixed(2)}):
"""
${ratifiedProposal}
"""

OBSERVER'S FINAL NOTE on that proposal:
"""
${observerReason}
"""

DEBATE TRAJECTORY (most recent cycles):
${previousVerdicts.slice(-3).join("\n") || "(no prior verdicts)"}

${timingBlock}

Issue your FINAL VERDICT now. Commit. No further debate.`;

  const startedAt = Date.now();
  // We intentionally let LLM/JSON errors propagate. The caller in
  // runMothershipCycle catches them and falls back to the legacy
  // awaiting_intervention path so the operator still has a manual escape
  // hatch. Swallowing the error here would silently mask infra failures.
  const response = await openai.chat.completions.create(withReasoningEffort({
    model: "gpt-5-mini",
    max_completion_tokens: 6000,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ],
    response_format: { type: "json_schema", json_schema: FINAL_VERDICT_SCHEMA },
  }, cfg.synthEffort ?? cfg.effort));
  const queenUsage = response.usage as OpenAIUsage;
  const rawText = response.choices[0]?.message?.content ?? "";
  if (!rawText.trim()) {
    throw new Error(`queenFinalVerdict returned empty content (finish_reason=${response.choices[0]?.finish_reason ?? "unknown"})`);
  }
  const payload = JSON.parse(rawText) as FinalVerdictPayload;

  const durationMs = Date.now() - startedAt;
  const verdictMarkdown = renderFinalVerdictMarkdown(payload, cycle, alignmentScore);
  // Per spec: packet verdict tag is the constant "FINAL_VERDICT" — the stance
  // (CONFIRM/COUNTER/STAND_DOWN) is carried separately in the markdown
  // (`Stance:` line) and on the queen_checkpoint event so consumers can
  // discriminate without overloading the verdict enum.
  const verdictTag = "FINAL_VERDICT";

  const packet = await db.insert(reasoningPackets).values({
    missionId,
    cycle,
    agentRole: "queen",
    reasoning: `Queen Final Verdict — ${payload.stance} (cycle ${cycle}, alignment ${alignmentScore.toFixed(2)}).`,
    proposal: verdictMarkdown,
    verdict: verdictTag,
    alignmentScore,
    durationMs,
  }).returning();

  if (queenUsage) {
    await recordCallCost({
      missionId,
      packetId: packet[0].id,
      cycle,
      agent: "QUEEN",
      usage: queenUsage,
      durationMs,
      sendEvent,
    });
  }

  sendEvent({
    type: "queen_checkpoint",
    data: {
      packetId: packet[0].id,
      cycle,
      thesisLock: verdictMarkdown,
      alignmentScore,
      agentRole: "queen",
      awaitingDecision: true,
      durationMs,
      verdict: verdictTag,
      stance: payload.stance,
      headline: payload.headline,
      tradePlan: payload.tradePlan,
      isFinalVerdict: true,
      selectedTimeframe: payload.selectedTimeframe,
      promotionReason: payload.promotionReason,
      reanchorReason: payload.reanchorReason,
      timing: {
        elapsedSec: timingSignal.elapsedSec,
        latencyBudgetSec: Number.isFinite(timingSignal.latencyBudgetSec) ? timingSignal.latencyBudgetSec : null,
        timingPressured: timingSignal.timingPressured,
        entryStale: timingSignal.entryStale,
        originalTimeframe: timingSignal.originalTimeframe,
      },
    },
  });

  if (payload.annotations) {
    await emitAnnotationsForPacket(packet[0].id, missionId, cycle, "queen", payload.annotations, sendEvent);
  }

  // Persist the structured FINAL_VERDICT JSON onto the mission so the
  // execution route can read numeric entry/stop/TPs without re-parsing
  // the markdown rendering. Latest verdict wins.
  await db.update(missions).set({
    finalVerdictJson: payload as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  }).where(eq(missions.id, missionId));

  return { thesisLock: verdictMarkdown, stance: payload.stance };
}

// ─── Executor (Final Deliverable Generator) ──────────────────────────────────
export async function executeDeliverable(
  missionId: number,
  primeObjective: string,
  thesisLock: string,
  approvalReason: string
): Promise<{ deliverable: string }> {
  const systemPrompt = `You are the EXECUTOR NODE in MOTHERSHIP. The Queen has approved a Thesis Lock and you must now produce the FINAL DELIVERABLE described in the Prime Objective.

Rules:
- Re-read the Prime Objective carefully and produce EVERY artifact it requests (lists, emails, briefings, code, etc.).
- The Thesis Lock is the strategic anchor — your deliverable must comply with it.
- If the objective asks for an email, write the full email (Subject, To/From placeholders, Body, Sign-off).
- If it asks for a list, produce the full enumerated list with concrete entries (real-world examples, not placeholders like "Firm A").
- Use clear section headers in CAPS so each artifact is easy to spot (e.g. "=== TARGET LIST ===", "=== EMAIL DRAFT ===").
- Be concrete, specific, and ready-to-ship. No hedging, no "I would suggest" — produce the actual artifact.`;

  const lastSynth = await db.query.reasoningPackets.findFirst({
    where: and(
      eq(reasoningPackets.missionId, missionId),
      eq(reasoningPackets.agentRole, "worker")
    ),
    orderBy: [desc(reasoningPackets.createdAt)],
  });
  const fallbackArtifact = lastSynth?.proposal?.trim() ?? "";

  const preCheck = await db.query.missions.findFirst({ where: eq(missions.id, missionId), columns: { status: true } });
  if (preCheck?.status === "aborted") {
    logger.info({ missionId }, "Executor aborted before LLM call");
    return { deliverable: "(aborted before execution)" };
  }

  const execMission = await db.query.missions.findFirst({ where: eq(missions.id, missionId), columns: { speedMode: true } });
  const execCfg = configForMode((execMission?.speedMode as SpeedMode) ?? "scalp");
  const execStartedAt = Date.now();
  const response = await openai.chat.completions.create(withReasoningEffort({
    model: "gpt-5-mini",
    max_completion_tokens: 16000,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `PRIME OBJECTIVE:\n"${primeObjective}"\n\nAPPROVED THESIS LOCK:\n"${thesisLock}"\n\nQUEEN APPROVAL NOTE:\n"${approvalReason}"\n\nLATEST RATIFIED SYNTHESIZER ARTIFACT (your starting point — polish & finalize this, do not start from scratch):\n"""\n${fallbackArtifact}\n"""\n\nProduce the final, ready-to-ship deliverable now. Include every artifact the Prime Objective requests with clear section headers.`
      }
    ]
  }, execCfg.synthEffort));
  const execDurationMs = Date.now() - execStartedAt;

  let deliverable = (response.choices[0]?.message?.content ?? "").trim();

  if (!deliverable && fallbackArtifact) {
    deliverable = `=== EXECUTOR FALLBACK (model returned empty after reasoning) ===\nUsing the Synthesizer's ratified artifact as the final deliverable:\n\n${fallbackArtifact}`;
  }
  if (!deliverable) {
    deliverable = "(executor returned empty output and no synthesizer fallback was available)";
  }

  const mission = await db.query.missions.findFirst({ where: eq(missions.id, missionId) });
  const cycle = mission?.cycleCount ?? 0;

  if (mission?.status === "aborted") {
    logger.info({ missionId }, "Executor finished but mission was aborted — discarding deliverable");
    // Even on abort, the OpenAI call already happened and cost real money.
    // Fold it into the mission total (no packet, no live tick — purely
    // accounting) so the spend is never silently dropped.
    await recordCallCost({
      missionId,
      packetId: null,
      cycle,
      agent: "EXECUTOR",
      usage: response.usage as OpenAIUsage,
      durationMs: execDurationMs,
    });
    return { deliverable };
  }

  const executorPacket = await db.insert(reasoningPackets).values({
    missionId,
    cycle,
    agentRole: "executor",
    reasoning: "Executor produced the final deliverable per the approved Thesis Lock.",
    proposal: deliverable,
    verdict: "DELIVERABLE",
    durationMs: execDurationMs,
  }).returning();

  await recordCallCost({
    missionId,
    packetId: executorPacket[0].id,
    cycle,
    agent: "EXECUTOR",
    usage: response.usage as OpenAIUsage,
    durationMs: execDurationMs,
    // Executor runs without an active SSE stream — cost is folded into the
    // mission total but no live tick is emitted (the UI will pick it up on
    // the next poll/refetch).
  });

  // Conditional flip: only mark the mission "completed" when it is still
  // in deliverable-controlled state (status='executing', currentPhase='executor').
  // When the queen/approve flow auto-fires executeMission(), that flow owns
  // status/currentPhase ('executing'/'live' on success, released to prev on
  // failure). An unconditional flip here would clobber an in-flight paper
  // bracket — making the UI report a closed mission while orders are still
  // open. Using AND-clause keeps the deliverable's terminal write idempotent
  // and race-safe.
  await db.update(missions).set({
    status: "completed",
    currentPhase: null,
    updatedAt: new Date(),
  }).where(and(
    eq(missions.id, missionId),
    eq(missions.status, "executing"),
    eq(missions.currentPhase, "executor"),
  ));

  return { deliverable };
}

async function getLatestQueenGuidance(missionId: number): Promise<string | null> {
  const packet = await db.query.reasoningPackets.findFirst({
    where: and(
      eq(reasoningPackets.missionId, missionId),
      eq(reasoningPackets.agentRole, "queen"),
      eq(reasoningPackets.verdict, "INTERVENTION")
    ),
    orderBy: [desc(reasoningPackets.createdAt)]
  });
  return packet?.proposal ?? null;
}

export class MissionAbortedError extends Error {
  constructor(missionId: number) {
    super(`Mission ${missionId} was aborted by user`);
    this.name = "MissionAbortedError";
  }
}

async function assertNotAborted(missionId: number): Promise<void> {
  const m = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { status: true },
  });
  if (m?.status === "aborted") {
    throw new MissionAbortedError(missionId);
  }
}

export async function runMothershipCycle(
  missionId: number,
  sendEvent: SendEvent
): Promise<void> {
  try {
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, missionId)
    });

    if (!mission) {
      sendEvent({ type: "error", data: { message: "Mission not found" } });
      return;
    }

    if (mission.status === "running") {
      sendEvent({ type: "error", data: { message: "Mission already running" } });
      return;
    }

    if (mission.status === "locked" || mission.status === "vetoed") {
      sendEvent({ type: "error", data: { message: `Mission is ${mission.status} — cannot resume` } });
      return;
    }

    const activeRules = await db.query.governanceRules.findMany({
      where: eq(governanceRules.active, true)
    });

    const ruleDescriptions = activeRules.map(r => `[${r.severity.toUpperCase()}] ${r.name}: ${r.description}`);

    const queenGuidance = await getLatestQueenGuidance(missionId);
    if (queenGuidance) {
      sendEvent({
        type: "queen_guidance",
        data: { guidance: queenGuidance, message: "Workers resuming with Queen guidance" }
      });
    }

    await db.update(missions).set({
      status: "running",
      currentPhase: "worker",
      updatedAt: new Date()
    }).where(eq(missions.id, missionId));

    const startCycle = (mission.cycleCount ?? 0) + 1;
    let cycle = startCycle;
    const previousVerdicts: string[] = [];
    let thesisLock = mission.thesisLock;
    // Cycle-2+ refinement: thread the prior cycle's ratified Synthesizer
    // proposal into the next Strategist/Adversary so they refine instead of
    // resetting. Reset to the earliest ratified proposal seen this run.
    let priorRatifiedProposal: string | null = null;
    let lastObserverReason: string = "";
    let lastAlignmentScore: number = 0;
    let lastMarketContextBlock: string = "";
    let lastMarketCtx: MarketContext | null = null;

    // Cadence + reasoning_effort selection per mission. Defaults to scalp so
    // missions created before this column existed still benefit from the fast
    // settings; explicit "swing" missions preserve the pre-Task-31 behavior.
    const speedMode: SpeedMode = (mission.speedMode as SpeedMode | undefined) ?? "scalp";
    const cfg = configForMode(speedMode);
    // Wall-clock anchor for the adaptive-timing signal — the Queen Final
    // Verdict step uses elapsed seconds since this point to detect when the
    // debate has eaten the trade window and the original entry plan is
    // likely stale. Reset per `runMothershipCycle` invocation (mission resumes
    // get a fresh budget — that's intentional).
    const missionStartedAt = Date.now();

    while (cycle < startCycle + cfg.maxCyclesPerRun) {
      await assertNotAborted(missionId);
      await db.update(missions).set({
        cycleCount: cycle,
        currentPhase: "worker",
        updatedAt: new Date()
      }).where(eq(missions.id, missionId));

      // Build a fresh market-context snapshot for this cycle (cached 2s, so all
      // five agents in the cycle share one upstream fetch).
      const { ctx: marketCtx, block: marketContextBlock } = await safeBuildContextBlock(mission.targetSymbol);

      const strategistProposal = await workerStrategist(
        mission.primeObjective, cycle, previousVerdicts, thesisLock, queenGuidance, priorRatifiedProposal, missionId, marketContextBlock, cfg, sendEvent
      );
      await assertNotAborted(missionId);
      const adversaryCritique = await workerAdversary(
        mission.primeObjective, cycle, strategistProposal, priorRatifiedProposal, missionId, marketContextBlock, cfg, sendEvent
      );
      await assertNotAborted(missionId);
      const ratifiedProposal = await workerSynthesizer(
        mission.primeObjective, cycle, strategistProposal, adversaryCritique, thesisLock, queenGuidance, missionId, marketContextBlock, marketCtx, cfg, sendEvent
      );

      await assertNotAborted(missionId);
      await db.update(missions).set({ currentPhase: "observer", updatedAt: new Date() }).where(eq(missions.id, missionId));

      const { verdict, reason, alignmentScore } = await observerNode(
        mission.primeObjective, ratifiedProposal, cycle, ruleDescriptions, missionId, marketContextBlock, marketCtx, cfg, sendEvent
      );
      await assertNotAborted(missionId);

      // Capture cycle outputs so the post-loop Final Verdict has the freshest
      // ratified proposal + observer note + market snapshot to commit on.
      priorRatifiedProposal = ratifiedProposal;
      lastObserverReason = reason;
      lastAlignmentScore = alignmentScore;
      lastMarketContextBlock = marketContextBlock;
      lastMarketCtx = marketCtx;

      sendEvent({
        type: "cycle_complete",
        data: { cycle, verdict, alignmentScore }
      });

      if (verdict === "ESCALATE") {
        await db.update(missions).set({
          currentPhase: "queen",
          status: "awaiting_queen",
          updatedAt: new Date()
        }).where(eq(missions.id, missionId));

        if (speedMode === "scalp") {
          // SCALP guarantee: every scalp run terminates with one Queen
          // FINAL_VERDICT packet — even when Observer escalates early. Funnel
          // the ESCALATE branch through queenFinalVerdict so the UI always
          // gets the decisive verdict contract instead of the legacy
          // thesis-lock packet. On verdict failure, fall back to
          // awaiting_intervention as the manual escape hatch.
          try {
            const escalateTimingSignal = assessTimingPressure({
              startedAt: missionStartedAt,
              ratifiedProposal,
              marketCtx,
              speedMode,
            });
            const { thesisLock: verdictLock } = await queenFinalVerdict({
              primeObjective: mission.primeObjective,
              ratifiedProposal,
              observerReason: reason,
              alignmentScore,
              cycle,
              previousVerdicts,
              marketContextBlock,
              marketCtx,
              missionId,
              cfg,
              sendEvent,
              timingSignal: escalateTimingSignal,
            });
            await db.update(missions).set({
              thesisLock: verdictLock,
              status: "awaiting_queen",
              updatedAt: new Date(),
            }).where(eq(missions.id, missionId));
            sendEvent({ type: "done", data: { status: "awaiting_queen", thesisLock: verdictLock, cycle } });
          } catch (verdictErr) {
            logger.error({ err: verdictErr, missionId }, "queenFinalVerdict (ESCALATE branch) failed; falling back to awaiting_intervention");
            await db.update(missions).set({
              status: "awaiting_intervention",
              currentPhase: "queen",
              updatedAt: new Date(),
            }).where(eq(missions.id, missionId));
            sendEvent({
              type: "deadlock",
              data: {
                message: `Final verdict step failed (${verdictErr instanceof Error ? verdictErr.message : "unknown"}). Manual Queen anchor required.`,
                finalCycle: cycle,
                recentVerdicts: previousVerdicts.slice(-3),
              },
            });
            sendEvent({ type: "done", data: { status: "awaiting_intervention", cycle } });
          }
          return;
        }

        // SWING: preserve legacy queenCheckpoint thesis-lock behavior on ESCALATE.
        const { thesisLock: newThesis } = await queenCheckpoint(
          mission.primeObjective, ratifiedProposal, cycle, alignmentScore, missionId, marketContextBlock, marketCtx, cfg, sendEvent
        );

        await db.update(missions).set({
          thesisLock: newThesis,
          status: "awaiting_queen",
          updatedAt: new Date()
        }).where(eq(missions.id, missionId));

        sendEvent({ type: "done", data: { status: "awaiting_queen", thesisLock: newThesis, cycle } });
        return;
      }

      if (verdict === "VETO") {
        previousVerdicts.push(`Cycle ${cycle} VETO (score ${alignmentScore.toFixed(2)}): ${reason.substring(0, 200)}`);
      } else {
        previousVerdicts.push(`Cycle ${cycle} PASS (score ${alignmentScore.toFixed(2)}): ${reason.substring(0, 200)}`);
      }

      cycle++;
    }

    // No ESCALATE escape happened. Behavior depends on speedMode:
    // - SCALP: force a decisive Queen FINAL VERDICT on the freshest ratified
    //   proposal. The mission lands in awaiting_queen so the existing approve
    //   (LOCK & EXECUTE) and veto (STAND DOWN) endpoints handle the next step.
    //   This is the "always-decisive" guarantee for the low-latency mode.
    // - SWING: keep the legacy thoroughness behavior — escalate to
    //   awaiting_intervention with a deadlock event so the operator can step
    //   in and provide a manual Queen anchor over a longer time horizon.
    if (speedMode !== "scalp") {
      logger.info({ missionId, speedMode, finalCycle: cycle - 1 }, "swing mission hit max cycles without ESCALATE — falling through to legacy awaiting_intervention");
      await db.update(missions).set({
        status: "awaiting_intervention",
        currentPhase: "queen",
        updatedAt: new Date(),
      }).where(eq(missions.id, missionId));
      sendEvent({
        type: "deadlock",
        data: {
          message: "Debate exhausted max cycles without ESCALATE. Manual Queen anchor required.",
          finalCycle: cycle - 1,
          recentVerdicts: previousVerdicts.slice(-3),
        },
      });
      sendEvent({ type: "done", data: { status: "awaiting_intervention", cycle: cycle - 1 } });
      return;
    }

    await db.update(missions).set({
      currentPhase: "queen",
      status: "awaiting_queen",
      updatedAt: new Date(),
    }).where(eq(missions.id, missionId));

    try {
      const postLoopTimingSignal = assessTimingPressure({
        startedAt: missionStartedAt,
        ratifiedProposal: priorRatifiedProposal,
        marketCtx: lastMarketCtx,
        speedMode,
      });
      const { thesisLock: verdictLock } = await queenFinalVerdict({
        primeObjective: mission.primeObjective,
        ratifiedProposal: priorRatifiedProposal ?? "(no ratified proposal — workers produced no usable thesis this run)",
        observerReason: lastObserverReason,
        alignmentScore: lastAlignmentScore,
        cycle: cycle - 1,
        previousVerdicts,
        marketContextBlock: lastMarketContextBlock,
        marketCtx: lastMarketCtx,
        missionId,
        cfg,
        sendEvent,
        timingSignal: postLoopTimingSignal,
      });

      await db.update(missions).set({
        thesisLock: verdictLock,
        status: "awaiting_queen",
        updatedAt: new Date(),
      }).where(eq(missions.id, missionId));

      sendEvent({ type: "done", data: { status: "awaiting_queen", thesisLock: verdictLock, cycle: cycle - 1 } });
    } catch (verdictErr) {
      // Final verdict failed (LLM error / timeout). Fall back to the legacy
      // intervention deadlock so the operator still has a manual escape hatch.
      logger.error({ err: verdictErr, missionId }, "queenFinalVerdict failed; falling back to awaiting_intervention");
      await db.update(missions).set({
        status: "awaiting_intervention",
        currentPhase: "queen",
        updatedAt: new Date(),
      }).where(eq(missions.id, missionId));
      sendEvent({
        type: "deadlock",
        data: {
          message: `Final verdict step failed (${verdictErr instanceof Error ? verdictErr.message : "unknown"}). Manual Queen anchor required.`,
          finalCycle: cycle - 1,
          recentVerdicts: previousVerdicts.slice(-3),
        },
      });
      sendEvent({ type: "done", data: { status: "awaiting_intervention", cycle: cycle - 1 } });
    }

  } catch (err) {
    if (err instanceof MissionAbortedError) {
      logger.info({ missionId }, "Mothership cycle aborted by user");
      await db.insert(reasoningPackets).values({
        missionId,
        cycle: 0,
        agentRole: "system",
        reasoning: "Mission aborted by operator (kill switch).",
        verdict: "ABORTED",
      }).catch(() => {});
      sendEvent({ type: "error", data: { message: "Mission aborted by operator" } });
      return;
    }
    logger.error({ err, missionId }, "Mothership cycle error");
    await db.update(missions).set({
      status: "pending",
      currentPhase: null,
      updatedAt: new Date()
    }).where(eq(missions.id, missionId)).catch(() => {});
    sendEvent({ type: "error", data: { message: err instanceof Error ? err.message : "Unknown error" } });
  }
}

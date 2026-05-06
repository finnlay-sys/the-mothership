# MOTHERSHIP

> **Adversarial AI Governance Engine** — a Glass Box runtime that prevents autonomous AI agents from executing high‑stakes actions, sealed with a cryptographic audit trail.

![Status](https://img.shields.io/badge/status-production%20ready-brightgreen)
![Version](https://img.shields.io/badge/version-2.0-blue)
![Node](https://img.shields.io/badge/node-%E2%89%A524-green)
![License](https://img.shields.io/badge/license-MIT-blue)
![Crypto](https://img.shields.io/badge/SHA--256-FIPS%20180--4-orange)

---

## The Problem

Autonomous AI agents are being deployed into high-stakes decision loops — trading desks, clinical triage, legal drafting, infrastructure operations — at a pace that has outrun governance. When a single LLM is given execution authority, three failure modes are guaranteed:

1. **Confident hallucination.** The model makes up reasoning that sounds rigorous and ships the wrong action.
2. **No audit trail.** When a regulator or insurer asks *"why did the AI do this?"*, the answer is `¯\_(ツ)_/¯`.
3. **No tamper resistance.** Logs after the fact can be edited, deleted, or selectively presented.

**Single-agent AI in production = uninsurable risk.**

---

## The Solution: Glass Box Architecture

MOTHERSHIP replaces the single-agent black box with an **adversarial triad** of LLMs operating under a fixed protocol, plus a cryptographic receipt that anchors every executed action to the exact reasoning that authorised it.

Three properties are enforced by construction, not by policy:

| Property | Mechanism |
|---|---|
| **No hallucination reaches execution** | The Worker proposes; a structurally independent Observer is mandated to veto on any rule violation. Two adversarial agents must agree before anything ships. |
| **Every action is explainable** | Every reasoning step (Worker proposal, Observer verdict, Queen final verdict) is persisted as an immutable `reasoning_packet` row before the next step runs. |
| **The audit trail is tamper-evident** | Every executed action appends a SHA-256–chained entry to an append-only ledger. Editing, deleting, or reordering any entry breaks every hash that follows it. |

### The four-phase cycle

```
                    ┌──────────────────────────────┐
                    │  PHASE 1 — INTAKE            │
                    │  Operator issues a Prime     │
                    │  Objective. Market / context │
                    │  intelligence is loaded.     │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  PHASE 2 — WORKER AGENT      │  "Argue aggressively
                    │  Generates a strategic       │   FOR the action."
                    │  proposal aligned with the   │
                    │  Prime Objective.            │
                    └──────────────┬───────────────┘
                                   │  proposal packet (immutable)
                                   ▼
                    ┌──────────────────────────────┐
                    │  PHASE 3 — OBSERVER AGENT    │  "Independent fiduciary.
                    │  Audits the proposal against │   Veto anything that
                    │  the Rules Engine.           │   violates risk policy."
                    │  Returns: PASS / VETO /      │
                    │           ESCALATE           │
                    └──────────────┬───────────────┘
                                   │  verdict packet (immutable)
                                   ▼
                    ┌──────────────────────────────┐
                    │  PHASE 4 — QUEEN VERDICT     │  Human-in-the-loop
                    │  Synthesises a Thesis Lock.  │  checkpoint. Operator
                    │  Operator approves or vetos. │  must sign off.
                    └──────────────┬───────────────┘
                                   │  FINAL_VERDICT packet (immutable)
                                   ▼
                    ┌──────────────────────────────┐
                    │  EXECUTOR                    │  Places the trade /
                    │  Tied to the FINAL_VERDICT   │  action with the
                    │  packet ID. Cannot fire      │  external venue.
                    │  without one.                │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  LEDGER                      │  SHA-256 chained,
                    │  Append-only NDJSON.         │  HMAC-signed export
                    │  hash[i] = SHA-256(          │  envelope for off-
                    │    hash[i-1] || body[i] )    │  machine archival.
                    └──────────────────────────────┘
```

The Observer cannot see the Worker's chain-of-thought — only its proposal — so the Worker cannot socially engineer the audit. The Queen verdict cannot reach the Executor without a corresponding packet ID. The Executor cannot append a ledger entry that doesn't reference an existing FINAL_VERDICT row. Each gate is structurally, not contractually, enforced.

---

## The Cryptographic Receipt

Every executed action emits one ledger entry. The hash chain is anchored at `GENESIS_HASH = "0" × 64` and continues forever:

```
hash[i] = SHA-256( hash[i-1] || canonicalJSON(body[i]) )
```

`canonicalJSON` is a stable, sorted, whitespace-free encoder (RFC 8785–compatible for our scope). One real entry, formatted for readability:

```json
{
  "index": 1837,
  "ts": "2026-05-06T01:42:08.119Z",
  "missionId": 412,
  "action": "submit",
  "source": "executor.real",
  "missionObjective": "Open a 5x long on ETH if 4h trend confirms continuation above 3,420.",
  "verdictRef": {
    "stance": "EXECUTE",
    "symbol": "ETH",
    "bias": "long",
    "cycle": 3,
    "packetId": 9214
  },
  "tradePlan": {
    "symbol": "ETH",
    "side": "buy",
    "leverage": 5,
    "sizeUsd": 2500,
    "entry": { "type": "limit", "price": 3428.50 },
    "stopLoss": 3380.00,
    "takeProfit": 3565.00
  },
  "payload": {
    "venue": "hyperliquid",
    "request":  { "coin": "ETH", "is_buy": true, "sz": 0.7295, "limit_px": 3428.5, "reduce_only": false },
    "response": { "status": "ok", "oid": 884412901, "ts": 1746494528119 }
  },
  "prevHash": "9f1c4d8a3b6e1c7d5a8f2e4b1c9d7a3e8f5b2c1a9d7e4f8b3c1a5d9e7f2b4c1a",
  "hash":     "a3e8f5b2c1a9d7e4f8b3c1a5d9e7f2b4c1a9f1c4d8a3b6e1c7d5a8f2e4b1c9d7"
}
```

Three properties any auditor can independently verify with nothing but the file and `sha256sum`:

1. **Forensic linkage.** `verdictRef.packetId` resolves to a specific Queen FINAL_VERDICT row in the audit trail. The `payload.request` is the exact bytes sent to the venue. The `payload.response` is the exact bytes returned.
2. **Local tamper detection.** Recompute `SHA-256(prevHash || canonicalJSON(body))` for any entry. If it doesn't match `hash`, that entry was edited.
3. **Global tamper detection.** Walk the whole file from index 0. The first `prevHash` mismatch is the first place the chain was broken — *and every entry after it is suspect*.

For off-machine archival, the operator can export the ledger inside an **HMAC-SHA256 envelope** that signs `(manifest || payload)` together — so a stale archive with a re-keyed manifest is also rejected.

```
[ envelope manifest line ]   <-- type, version, exportedAt, entryCount, lastHash, HMAC signature
[ entry 0  ]
[ entry 1  ]
   ...
[ entry N  ]
```

Verification (in pseudocode) is roughly twelve lines and depends on no MOTHERSHIP code:

```python
import hashlib, hmac, json
manifest, *entries = open(path).read().splitlines()
m = json.loads(manifest); sig = m.pop("signature")
canonical = json.dumps(m, sort_keys=True, separators=(",", ":"))
payload = "\n".join(entries) + ("\n" if entries else "")
expected = hmac.new(KEY, (canonical + "\n" + payload).encode(), hashlib.sha256).hexdigest()
assert expected == sig, "envelope tampered"

prev = "0" * 64
for line in entries:
    e = json.loads(line); body = {k: e[k] for k in e if k not in ("prevHash", "hash")}
    c = json.dumps(body, sort_keys=True, separators=(",", ":"))
    assert hashlib.sha256((prev + c).encode()).hexdigest() == e["hash"], f"break at {e['index']}"
    prev = e["hash"]
```

---

## Why this is uninsurable risk → insurable risk

| Conventional single-agent AI | MOTHERSHIP |
|---|---|
| One model decides and executes. | Two adversarial models must agree; a human signs the final verdict. |
| Reasoning is ephemeral. | Every reasoning step is persisted before the next step runs. |
| Logs are mutable, post-hoc, selectively presentable. | Logs are SHA-256 chained at write-time and HMAC-sealed at export. |
| "Trust the AI." | Verify the chain. |

This is the property that makes MOTHERSHIP underwritable: an underwriter, a compliance officer, or a regulator can be handed a single signed file and answer *"did the AI act inside its mandate, and is this the complete record?"* in seconds, without trusting the operator and without trusting the AI.

---

## Stack

- **Runtime:** Node.js 24 · TypeScript 5.9 · Express 5
- **Persistence:** PostgreSQL · Drizzle ORM · `zod/v4` validated boundaries · `drizzle-zod`
- **API contract:** OpenAPI → Orval-generated React Query hooks and Zod schemas
- **Frontend:** React · Vite · Tailwind CSS — dashboard, mission log, live "Fight" view, immutable audit, ledger explorer, governance rules editor
- **Crypto:** Node `crypto` (FIPS 180-4 SHA-256, HMAC-SHA256)
- **LLMs:** OpenAI `gpt-5-mini` via Replit AI Integrations proxy
- **Orchestration:** Native LangGraph-style stateful cycle in TypeScript (no LangGraph dependency)

## Repo Map

```
artifacts/
  api-server/          Express API + agent orchestrator + executors
    src/lib/
      mothership-engine.ts    Worker / Observer / Queen state machine + SSE
      execution-engine.ts     Venue adapters (Hyperliquid, paper)
      ledger.ts               SHA-256 chained ledger + HMAC export
  mothership/          React + Vite operator console
lib/
  db/src/schema/missions.ts   Mission + reasoning_packets + vetoes + governance_rules
  api-spec/                   OpenAPI source of truth
  api-zod/                    Generated Zod schemas
```

## Run

```bash
pnpm install
pnpm --filter @workspace/db run push           # provision schema
pnpm --filter @workspace/api-server run dev    # API + agents
pnpm --filter @workspace/mothership run dev    # operator console
```

Required env: `DATABASE_URL`, `SESSION_SECRET`, `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, and `LEDGER_SIGNING_KEY` (or it falls back to `SESSION_SECRET`) for signed exports.

## License

MIT. See [LICENSE](./LICENSE).

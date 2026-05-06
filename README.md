# 🛸 The Mothership

> **Adversarial AI Governance Engine** — a Glass Box runtime that prevents autonomous AI agents from executing high-risk actions, sealed with a cryptographic audit trail.

![Status](https://img.shields.io/badge/status-production%20ready-brightgreen)
![Version](https://img.shields.io/badge/version-2.0-blue)
![Node](https://img.shields.io/badge/node-%E2%89%A518.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)
![Crypto](https://img.shields.io/badge/SHA--256-FIPS%20180--4-orange)

---

## The Problem

Autonomous AI agents are being deployed into high-stakes decision loops - trading desks, clinical triage, legal drafting, infrastructure operations - at a pace that has outrun governance. When a single LLM is given execution authority, three failure modes are guaranteed:

1. **Confident hallucination.** The model makes up reasoning that sounds rigorous and ships the wrong action.
2. **No audit trail.** When a regulator or insurer asks "why did the AI do this?", the answer is `¯\_(ツ)_/¯`.
3. **No tamper resistance.** Logs after the fact can be edited, deleted, or selectively presented.

Single-agent AI in production = uninsurable risk.

---

## The Solution: Glass Box Architecture

The Mothership solves this with an **adversarial triad** — two AI agents with diametrically opposed mandates, sealed by a cryptographic receipt. No action reaches execution without passing through all four phases:

```
                    ┌──────────────────────────────┐
                    │  PHASE 1: INTAKE             │
                    │  Load market intelligence    │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  PHASE 2: WORKER AGENT       │   "Aggressively argue
                    │  Argues FOR the action       │    for the trade"
                    └──────────────┬───────────────┘
                                   │
                                   │   (raw output, no system prompt leakage)
                                   ▼
                    ┌──────────────────────────────┐
                    │  PHASE 3: OBSERVER AGENT     │   "Veto anything that
                    │  Independent fiduciary       │    violates risk policy"
                    │  veto authority              │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  PHASE 4: CRYPTOGRAPHIC SEAL │   SHA-256 of the full
                    │  Tamper-evident receipt      │   transcript
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                              FINAL VERDICT
                            APPROVED / VETOED
                          + 64-char hash receipt
```

**Why this design wins an audit:**

| Property | Single-agent AI | The Mothership |
|---|---|---|
| Independent risk review | ❌ | ✅ Observer with absolute veto |
| Tamper-evident logs | ❌ | ✅ SHA-256 over full transcript |
| Information firewall between agents | ❌ | ✅ Worker cannot see Observer's policy |
| Fail-closed on errors | ❌ | ✅ Any failure → no action |
| Zero hardcoded credentials | ⚠️ Common | ✅ Enforced at startup |

---

## Live Demo

```
════════════════════════════════════════════════════════════════════════
  THE MOTHERSHIP  //  ADVERSARIAL AI GOVERNANCE ENGINE  v2.0
════════════════════════════════════════════════════════════════════════

  [BOOT]  Initialising risk kernel...
  [BOOT]  Environment credentials validated (zero hardcoded secrets).
  [BOOT]  Loading cryptographic primitives (SHA-256, FIPS 180-4)...
  [BOOT]  Adversarial triad ARMED. Governance loop ready.

  ════════════════════════════════════════════════════════════════════
    PHASE 3  //  OBSERVER AGENT  [FIDUCIARY RISK VETO]
  ════════════════════════════════════════════════════════════════════

  [STATUS: VETOED]
  100x leverage in an EXTREME volatility environment with CRITICAL
  liquidation cascade risk is pure capital Russian roulette, not
  risk-managed trading. A $500,000 notional with zero drawdown
  tolerance will be instantly vaporized by even a routine wick...

  ════════════════════════════════════════════════════════════════════
    FINAL VERDICT  //  [VETOED]
  ════════════════════════════════════════════════════════════════════

  ██  ORDER VETOED  ██
  Session hash: 76d0d57df6dce4fbab755972396a83cb9f769546e9d27e9eefc40e9f676cc3ff
```

In this run the Worker constructed a 6-paragraph bull thesis advocating a `MARKET_BUY_100x_LEVERAGE` action on ETH/USD. The Observer vetoed in 4 sentences. The full 3,150-byte transcript was sealed under a single 64-character hash.

---

## Architecture: The Four Phases

| Phase | Component | What it does | Trust level |
|---|---|---|---|
| **1** | **INTAKE** | Loads `market_payload.json` (the action under review) and displays it. Fails closed if the payload is unreadable. | System |
| **2** | **WORKER AGENT** | An LLM prompted to *argue aggressively for* executing the action. Its output is treated as adversarial input. | UNTRUSTED |
| **3** | **OBSERVER AGENT** | A second, independent LLM prompted as a fiduciary risk manager. Receives only the Worker's raw text — never its system prompt. Renders binding `[STATUS: APPROVED]` or `[STATUS: VETOED]`. | TRUSTED AUTHORITY |
| **4** | **CRYPTO SEAL** | SHA-256 hash over `WORKER_OUTPUT \|\| OBSERVER_VERDICT`. Any post-hoc edit invalidates the hash. | Cryptographic guarantee |

---

## Quick Start

```bash
git clone https://github.com/finnlay-sys/the-mothership.git
cd the-mothership
npm install
```

Create a `.env` file in the project root:

```env
AI_INTEGRATIONS_OPENAI_BASE_URL=https://api.openai.com/v1
AI_INTEGRATIONS_OPENAI_API_KEY=sk-...your-key-here...
```

Run the governance loop:

```bash
node index.js
```

> **Replit users:** the environment variables are auto-provisioned via the Replit AI Integrations layer. No manual `.env` required.

---

## Customise the Scenario

Edit `market_payload.json` to change the asset, price, volatility, or proposed action. The agents adapt their reasoning to whatever payload they receive.

```json
{
  "asset": "ETH/USD",
  "price": 3050.00,
  "volatility": "EXTREME",
  "suggested_action": "MARKET_BUY_100x_LEVERAGE",
  "rsi": 91.4,
  "market_sentiment": "EUPHORIC",
  "liquidation_cascade_risk": "CRITICAL"
}
```

Try toggling `volatility` to `LOW` and `suggested_action` to `MARKET_BUY_2x_LEVERAGE` — the Observer flips to `[STATUS: APPROVED]`.

---

## Tech Stack

| Layer | Tool | Why |
|---|---|---|
| Runtime | Node.js (CommonJS) | Zero build step, instant cold start |
| LLM | OpenAI `gpt-5.1` (configurable) | Best-in-class reasoning |
| Cryptography | Node native `crypto` module | FIPS 140-2 compatible, no third-party trust |
| Config | `dotenv` | Twelve-factor-app credential handling |
| Output | Pure ANSI escape codes | No TUI dependency, runs anywhere |

---

## Why This Matters Beyond Trading

The same adversarial triad pattern applies to any high-stakes AI workflow:

- **Healthcare** — clinical-decision support with a fiduciary "do no harm" Observer
- **Legal** — contract-drafting Worker, regulatory-compliance Observer
- **Infrastructure** — auto-remediation Worker, change-control Observer
- **Defense** — target-recommendation Worker, rules-of-engagement Observer
- **Capital allocation** — investment-thesis Worker, fund-mandate Observer

The Mothership's reference implementation is in trading because trading has the cleanest risk metrics. The architecture is domain-agnostic.

---

## Roadmap

- [x] **v1.0** — Single-run CLI loop with Worker + Observer + SHA-256 seal
- [x] **v2.0** — Hardened for enterprise audit (env validation, function isolation, error handling)
- [ ] **v2.1** — Persist sealed receipts to append-only log (`receipts.jsonl`)
- [ ] **v2.2** — Pluggable Observer policies (load from YAML)
- [ ] **v3.0** — REST API + webhook delivery for production integration
- [ ] **v3.1** — Merkle tree of session hashes → daily root hash anchored on-chain
- [ ] **v4.0** — Multi-Observer quorum (e.g. 2-of-3 risk managers)

---

## Security Model

- **Zero hardcoded credentials.** Enforced at startup by `validateEnvironment()`. Process exits non-zero if any required env var is missing.
- **Information firewall.** The Observer never sees the Worker's system prompt, temperature, or model config. It only sees the Worker's raw output.
- **Fail-closed.** Any error in any phase aborts the entire loop. No partial execution, no silent fallbacks.
- **Tamper-evident.** Single-character changes to either agent's output produce a completely different SHA-256. The hash is the receipt.
- **No PII in prompts.** Reference implementation uses only synthetic market data.

For a full security walkthrough, see the inline JSDoc in [`index.js`](./index.js).

---

## File Layout

```
the-mothership/
├── index.js              # The full governance loop (≈ 500 lines, single file by design)
├── market_payload.json   # The action under review
├── package.json          # 2 production deps: openai, dotenv
├── .gitignore
├── LICENSE               # MIT
└── README.md             # You are here
```

---

## License

MIT — see [LICENSE](./LICENSE).

---

## Contact

Built by [@finnlay-sys](https://github.com/finnlay-sys).

For commercial licensing, integration partnerships, or due diligence enquiries: open a GitHub issue or reach out directly.

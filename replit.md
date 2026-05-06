# MOTHERSHIP Workspace

## Overview

MOTHERSHIP is a production-grade multi-agent governance system. A LangGraph-style stateful cycle orchestrates three AI agents — Worker, Observer, and Queen — to ensure all AI actions are aligned with a Prime Objective issued by the Queen.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: OpenAI via Replit AI Integrations (gpt-5-mini) — no user API key needed
- **Frontend**: React + Vite + Tailwind CSS

## Architecture

### Agent Orchestration (LangGraph-style stateful cycle)

Located in `artifacts/api-server/src/lib/mothership-engine.ts`:

1. **Worker Node** — Generates strategic proposals aligned with the Prime Objective
2. **Observer Node** — Audits proposals against the Rules Engine; returns PASS, VETO, or ESCALATE
3. **Queen Node** — Human-in-the-loop checkpoint; synthesizes a Thesis Lock for Queen approval

Streamed via Server-Sent Events on `POST /api/missions/:id/run`.

### Database Schema (`lib/db/src/schema/missions.ts`)

- **missions** — Core mission table with status, cycleCount, thesisLock
- **reasoning_packets** — Immutable audit trail of all agent reasoning (Worker, Observer, Queen)
- **vetoes** — Immutable veto records (Observer vetoes and Queen vetoes)
- **governance_rules** — Rules Engine constraints used by Observer

### API Routes

- `GET/POST /api/missions` — List and create missions
- `GET /api/missions/:id` — Mission details
- `POST /api/missions/:id/run` — Start agent cycle (SSE stream)
- `GET /api/missions/:id/status` — Mission status
- `GET /api/missions/:id/reasoning-packets` — Immutable reasoning audit
- `GET /api/missions/:id/vetoes` — Immutable veto audit
- `POST /api/missions/:id/queen/approve` — Queen approves Thesis Lock
- `POST /api/missions/:id/queen/veto` — Queen issues veto
- `GET /api/audit/recent` — Recent system-wide audit entries
- `GET /api/audit/stats` — System-wide statistics
- `GET/POST /api/rules` — Governance Rules Engine

### Frontend Pages (`artifacts/mothership/src/`)

- `/` — System Dashboard (stats, recent packets, recent vetoes)
- `/missions` — Mission Log (all missions with status)
- `/missions/new` — Issue Directive (create new mission)
- `/missions/:id` — Mission Detail + Live "Fight" view (SSE stream, Queen control panel)
- `/audit` — Full immutable audit trail
- `/rules` — Governance Rules Engine

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string
- `AI_INTEGRATIONS_OPENAI_BASE_URL` — Replit AI Integrations proxy URL
- `AI_INTEGRATIONS_OPENAI_API_KEY` — Replit AI Integrations API key
- `SESSION_SECRET` — Session secret

## Important Notes

- The Observer's `QueenApproveBody` and `QueenVetoBody` Zod schemas come from `@workspace/api-zod` (generated)
- `lib/api-zod/src/index.ts` only exports from `./generated/api` to avoid naming conflicts with `./generated/types`
- LangGraph orchestration is implemented natively in TypeScript without the LangGraph library (full stateful graph logic)

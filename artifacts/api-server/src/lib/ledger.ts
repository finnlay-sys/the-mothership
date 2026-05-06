import { createHash, createHmac } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { logger } from "./logger";

// =============================================================================
// Tamper-evident trade ledger (Task #37)
//
// Append-only newline-delimited JSON file. Every entry includes the SHA-256
// hash of (prevHash + canonicalJSON(body)), so the file forms a single chain
// anchored to a known genesis hash. Editing, deleting, or reordering any
// entry breaks every hash that follows it — `verifyLedger()` reports the
// first index where the chain breaks.
//
// The ledger is a forensic record of WHY/HOW/WHEN/WHERE the agent placed each
// trade: it carries the mission objective, the Queen Final Verdict reference,
// the trade plan snapshot, and the action-specific request/response payload.
// Secrets (private keys, operator tokens, etc.) are scrubbed before write.
// =============================================================================

export const GENESIS_HASH = "0".repeat(64);

export const LEDGER_ACTIONS = [
  "submit", "fill", "cancel", "kill", "close", "error",
] as const;
export type LedgerAction = (typeof LEDGER_ACTIONS)[number];

// Body that gets hashed. Keep this object stable: any field reordering or
// renaming changes the canonical JSON and therefore the hash, which would
// invalidate every existing ledger file.
export type LedgerEntryBody = {
  index: number;
  ts: string;                  // ISO-8601 UTC
  missionId: number | null;
  action: LedgerAction;
  source: string;              // e.g. "executor.real", "executor.paper", "kill", "sync"
  missionObjective: string | null;
  verdictRef: {
    stance: string;
    symbol: string | null;
    bias: string | null;
    cycle: number | null;
    // Reasoning-packet row ID of the Queen FINAL_VERDICT that authorised the
    // execution — strict forensic linkage back to the exact debate output.
    packetId: number | null;
  } | null;
  tradePlan: unknown | null;   // snapshot of the Queen FINAL_VERDICT trade plan
  payload: unknown;            // action-specific (request/response, fills, errors)
};

export type LedgerEntry = LedgerEntryBody & {
  prevHash: string;
  hash: string;
};

export type AppendInput = Omit<LedgerEntryBody, "index" | "ts"> & {
  ts?: string;
};

// =============================================================================
// File location
// =============================================================================

function ledgerPath(): string {
  if (process.env.LEDGER_FILE) return process.env.LEDGER_FILE;
  return path.resolve(process.cwd(), "data", "ledger.jsonl");
}

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

// =============================================================================
// Canonical JSON + hashing
//
// Stable key sort, no whitespace. Mirrors RFC 8785 well enough for our use.
// (We do not hash the prevHash inside the body — prevHash is concatenated
// outside the canonical body so we can clearly express "hash =
// SHA-256(prevHash || canonical(body))" without circular fields.)
// =============================================================================

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map((k) =>
      JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]),
    );
    return "{" + parts.join(",") + "}";
  }
  return "null";
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function computeHash(prevHash: string, body: LedgerEntryBody): string {
  return sha256Hex(prevHash + canonicalJson(body));
}

// =============================================================================
// Secret scrubbing
//
// Defensive: callers should already exclude secrets from `payload`, but if a
// future call site forgets, we strip well-known credential keys before write.
// =============================================================================

const SECRET_KEY_RE = /^(privateKey|operatorToken|password|secret|apiKey|sessionSecret|encryptedPrivateKey)$/i;

function scrubSecrets<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => scrubSecrets(v, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = scrubSecrets(v, depth + 1);
    }
  }
  return out as unknown as T;
}

// =============================================================================
// Append (serialized via in-process mutex)
// =============================================================================

let _writeChain: Promise<unknown> = Promise.resolve();

async function readLastEntry(file: string): Promise<LedgerEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // Walk lines from the end; skip blanks. JSONL guarantees one entry per line.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    return JSON.parse(line) as LedgerEntry;
  }
  return null;
}

export async function appendLedgerEntry(input: AppendInput): Promise<LedgerEntry> {
  // .catch() before .then() so a single failed append (transient disk error,
  // race during readLastEntry, etc.) cannot poison `_writeChain` and silently
  // reject every subsequent caller. Each turn starts from a resolved state.
  return _writeChain = _writeChain.catch(() => undefined).then(async () => {
    const file = ledgerPath();
    await ensureDir(file);
    const last = await readLastEntry(file);
    const prevHash = last ? last.hash : GENESIS_HASH;
    const index = last ? last.index + 1 : 0;
    const ts = input.ts ?? new Date().toISOString();

    const rawBody: LedgerEntryBody = {
      index, ts,
      missionId: input.missionId,
      action: input.action,
      source: input.source,
      missionObjective: input.missionObjective,
      verdictRef: input.verdictRef,
      tradePlan: scrubSecrets(input.tradePlan ?? null),
      payload: scrubSecrets(input.payload ?? null),
    };
    // Normalise via JSON round-trip BEFORE hashing so any `undefined`-valued
    // keys (which JSON.stringify silently drops) are stripped consistently
    // in both the hashed body and the on-disk line. Otherwise verifyLedger
    // would re-parse from disk without those keys and recompute a different
    // hash than the one that was originally written.
    const body = JSON.parse(JSON.stringify(rawBody)) as LedgerEntryBody;
    const hash = computeHash(prevHash, body);
    const entry: LedgerEntry = { ...body, prevHash, hash };
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }) as Promise<LedgerEntry>;
}

// Best-effort wrapper: never lets a ledger failure break the execution flow.
// (The audit trail is already its own backstop; the ledger is an additional
// forensic layer.)
export async function tryAppendLedgerEntry(input: AppendInput): Promise<void> {
  try { await appendLedgerEntry(input); }
  catch (err) { logger.error({ err, action: input.action, missionId: input.missionId }, "ledger append failed"); }
}

// =============================================================================
// Read / verify
// =============================================================================

export type ReadAllResult = {
  entries: LedgerEntry[];
  tailCorruption: { lineNumber: number; raw: string } | null;
};

export async function readAllEntriesDetailed(): Promise<ReadAllResult> {
  const file = ledgerPath();
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], tailCorruption: null };
    throw err;
  }
  const out: LedgerEntry[] = [];
  let tailCorruption: ReadAllResult["tailCorruption"] = null;
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as LedgerEntry);
      tailCorruption = null; // a successful parse after a bad line means the bad one wasn't the tail
    } catch {
      tailCorruption = { lineNumber: i + 1, raw: t.slice(0, 120) };
    }
  }
  return { entries: out, tailCorruption };
}

export async function readAllEntries(): Promise<LedgerEntry[]> {
  return (await readAllEntriesDetailed()).entries;
}

export type LedgerQuery = {
  missionId?: number | null;
  action?: LedgerAction | null;
  after?: string | null;       // ISO timestamp, exclusive
  before?: string | null;      // ISO timestamp, exclusive
  limit?: number;
  offset?: number;
};

export async function readLedger(q: LedgerQuery = {}): Promise<{
  entries: LedgerEntry[];
  total: number;
}> {
  const all = await readAllEntries();
  const filtered = all.filter((e) => {
    if (q.missionId != null && e.missionId !== q.missionId) return false;
    if (q.action && e.action !== q.action) return false;
    if (q.after && !(e.ts > q.after)) return false;
    if (q.before && !(e.ts < q.before)) return false;
    return true;
  });
  const total = filtered.length;
  const offset = Math.max(0, q.offset ?? 0);
  const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 5000) : filtered.length;
  return { entries: filtered.slice(offset, offset + limit), total };
}

export type VerifyResult = {
  ok: boolean;
  totalEntries: number;
  lastHash: string;
  brokeAtIndex: number | null;
  brokeAtReason: string | null;
};

export async function verifyLedger(opts: { missionId?: number | null } = {}): Promise<VerifyResult & {
  missionEntries?: number;
}> {
  const { entries: all, tailCorruption } = await readAllEntriesDetailed();
  let prevHash = GENESIS_HASH;
  let expectedIndex = 0;
  let missionEntries = 0;
  for (const e of all) {
    if (e.index !== expectedIndex) {
      return { ok: false, totalEntries: all.length, lastHash: prevHash,
        brokeAtIndex: expectedIndex,
        brokeAtReason: `index gap: expected ${expectedIndex}, got ${e.index}`,
        missionEntries };
    }
    if (e.prevHash !== prevHash) {
      return { ok: false, totalEntries: all.length, lastHash: prevHash,
        brokeAtIndex: e.index,
        brokeAtReason: `prevHash mismatch at index ${e.index}`,
        missionEntries };
    }
    const body: LedgerEntryBody = {
      index: e.index, ts: e.ts, missionId: e.missionId, action: e.action,
      source: e.source, missionObjective: e.missionObjective,
      verdictRef: e.verdictRef, tradePlan: e.tradePlan, payload: e.payload,
    };
    const recomputed = computeHash(prevHash, body);
    if (recomputed !== e.hash) {
      return { ok: false, totalEntries: all.length, lastHash: prevHash,
        brokeAtIndex: e.index,
        brokeAtReason: `hash mismatch at index ${e.index}`,
        missionEntries };
    }
    prevHash = e.hash;
    expectedIndex++;
    if (opts.missionId != null && e.missionId === opts.missionId) missionEntries++;
  }
  if (tailCorruption) {
    return { ok: false, totalEntries: all.length, lastHash: prevHash,
      brokeAtIndex: all.length,
      brokeAtReason: `tail corruption: unparseable line ${tailCorruption.lineNumber} ("${tailCorruption.raw}")`,
      ...(opts.missionId != null ? { missionEntries } : {}) };
  }
  return { ok: true, totalEntries: all.length, lastHash: prevHash,
    brokeAtIndex: null, brokeAtReason: null,
    ...(opts.missionId != null ? { missionEntries } : {}) };
}

export async function exportLedgerNdjson(): Promise<string> {
  const all = await readAllEntries();
  return all.map((e) => JSON.stringify(e)).join("\n") + (all.length ? "\n" : "");
}

// =============================================================================
// Signed export
//
// The raw NDJSON file IS already tamper-evident on its own (every line carries
// the SHA-256 hash chain), but for off-machine archival we wrap it in an HMAC
// envelope so the operator can also prove the export wasn't truncated, padded,
// or substituted between the server and the archive.
//
// Wire format: line 1 is a JSON manifest, lines 2..N+1 are the original
// ledger entries, in order. Verification (independent of this codebase):
//   payload = bytes from end of line 1 to EOF
//   computed = HMAC-SHA256(signingKey, payload).hex
//   computed === manifest.signature  &&  manifest.lastHash === payload's last entry hash
// =============================================================================

export const SIGNED_EXPORT_VERSION = 1;
export const SIGNED_EXPORT_ALGO = "HMAC-SHA256";

function signingKey(): string {
  const k = process.env.LEDGER_SIGNING_KEY || process.env.SESSION_SECRET;
  if (!k) {
    throw new Error(
      "ledger signing key missing: set LEDGER_SIGNING_KEY (or SESSION_SECRET) " +
      "before exporting/verifying signed ledger envelopes",
    );
  }
  return k;
}

export type SignedExportManifest = {
  type: "ledger-export-envelope";
  version: number;
  exportedAt: string;
  entryCount: number;
  lastHash: string;
  algorithm: string;
  signature: string;
};

// Build the bytes that the HMAC covers. The signature is computed over
// canonicalJson(manifestWithoutSignature) + "\n" + payload, so manifest
// metadata (entryCount, lastHash, exportedAt, version, algorithm) is
// inside the signed scope and cannot be silently re-keyed in the archive.
function signedScope(unsignedManifest: Record<string, unknown>, payload: string): string {
  return canonicalJson(unsignedManifest) + "\n" + payload;
}

export async function exportLedgerSigned(): Promise<{
  body: string;
  manifest: SignedExportManifest;
}> {
  const all = await readAllEntries();
  const payload = all.map((e) => JSON.stringify(e)).join("\n") + (all.length ? "\n" : "");
  const lastHash = all.length ? all[all.length - 1].hash : GENESIS_HASH;
  const unsigned = {
    type: "ledger-export-envelope",
    version: SIGNED_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    entryCount: all.length,
    lastHash,
    algorithm: SIGNED_EXPORT_ALGO,
  };
  const signature = createHmac("sha256", signingKey())
    .update(signedScope(unsigned, payload), "utf8")
    .digest("hex");
  const manifest: SignedExportManifest = { ...unsigned, signature } as SignedExportManifest;
  return { body: JSON.stringify(manifest) + "\n" + payload, manifest };
}

// Re-verify a previously exported envelope. Used by the verify endpoint and
// available for operator-side scripts.
export function verifySignedExport(envelope: string): {
  ok: boolean;
  reason: string | null;
  manifest: SignedExportManifest | null;
} {
  const nl = envelope.indexOf("\n");
  if (nl < 0) return { ok: false, reason: "missing manifest line", manifest: null };
  let manifest: SignedExportManifest;
  try { manifest = JSON.parse(envelope.slice(0, nl)); }
  catch { return { ok: false, reason: "manifest is not JSON", manifest: null }; }
  if (manifest.type !== "ledger-export-envelope") {
    return { ok: false, reason: "wrong envelope type", manifest };
  }
  const payload = envelope.slice(nl + 1);
  const { signature, ...unsigned } = manifest as Record<string, unknown> & {
    signature: string;
  };
  const expected = createHmac("sha256", signingKey())
    .update(signedScope(unsigned, payload), "utf8")
    .digest("hex");
  if (expected !== signature) {
    return { ok: false, reason: "signature mismatch", manifest };
  }
  // Cross-check the in-band metadata against the actual payload so a
  // manifest with bumped entryCount/lastHash but stale payload also fails.
  const lines = payload.split("\n").filter((l) => l.length > 0);
  if (lines.length !== manifest.entryCount) {
    return { ok: false, reason: "entryCount mismatch", manifest };
  }
  let lastEntryHash = GENESIS_HASH;
  if (lines.length > 0) {
    try { lastEntryHash = (JSON.parse(lines[lines.length - 1]) as LedgerEntry).hash; }
    catch { return { ok: false, reason: "last entry not parseable", manifest }; }
  }
  if (lastEntryHash !== manifest.lastHash) {
    return { ok: false, reason: "lastHash mismatch", manifest };
  }
  return { ok: true, reason: null, manifest };
}

// =============================================================================
// Mission slice verification
//
// Walks the global chain (so any tamper to a non-mission entry still surfaces
// as a chain break) and additionally tracks the mission's slice: how many
// entries belong to it, their first/last global index, and the hash of the
// mission's last entry — a per-mission anchor the operator can quote
// independently of the global lastHash. Mission entries are not required to
// be contiguous in the global chain; interleaving with other missions is
// expected and not treated as tampering.
// =============================================================================

export type MissionSliceResult = {
  ok: boolean;
  totalEntries: number;        // count across the whole ledger
  missionEntries: number;      // count belonging to this mission
  missionFirstIndex: number | null;
  missionLastIndex: number | null;
  missionLastHash: string | null;
  brokeAtIndex: number | null;
  brokeAtReason: string | null;
};

export async function verifyMissionSlice(missionId: number): Promise<MissionSliceResult> {
  const { entries: all, tailCorruption } = await readAllEntriesDetailed();
  let prevHash = GENESIS_HASH;
  let expectedIndex = 0;
  let missionEntries = 0;
  let missionFirstIndex: number | null = null;
  let missionLastIndex: number | null = null;
  let missionLastHash: string | null = null;
  for (const e of all) {
    if (e.index !== expectedIndex) {
      return { ok: false, totalEntries: all.length, missionEntries,
        missionFirstIndex, missionLastIndex, missionLastHash,
        brokeAtIndex: expectedIndex,
        brokeAtReason: `index gap at ${expectedIndex} (got ${e.index})` };
    }
    if (e.prevHash !== prevHash) {
      return { ok: false, totalEntries: all.length, missionEntries,
        missionFirstIndex, missionLastIndex, missionLastHash,
        brokeAtIndex: e.index,
        brokeAtReason: `prevHash mismatch at index ${e.index}` };
    }
    const body: LedgerEntryBody = {
      index: e.index, ts: e.ts, missionId: e.missionId, action: e.action,
      source: e.source, missionObjective: e.missionObjective,
      verdictRef: e.verdictRef, tradePlan: e.tradePlan, payload: e.payload,
    };
    if (computeHash(prevHash, body) !== e.hash) {
      return { ok: false, totalEntries: all.length, missionEntries,
        missionFirstIndex, missionLastIndex, missionLastHash,
        brokeAtIndex: e.index,
        brokeAtReason: e.missionId === missionId
          ? `mission entry tampered at index ${e.index}`
          : `chain hash mismatch at index ${e.index}`,
      };
    }
    if (e.missionId === missionId) {
      missionEntries++;
      if (missionFirstIndex === null) missionFirstIndex = e.index;
      missionLastIndex = e.index;
      missionLastHash = e.hash;
    }
    prevHash = e.hash;
    expectedIndex++;
  }
  if (tailCorruption) {
    return { ok: false, totalEntries: all.length, missionEntries,
      missionFirstIndex, missionLastIndex, missionLastHash,
      brokeAtIndex: all.length,
      brokeAtReason: `tail corruption: line ${tailCorruption.lineNumber}` };
  }
  return { ok: true, totalEntries: all.length, missionEntries,
    missionFirstIndex, missionLastIndex, missionLastHash,
    brokeAtIndex: null, brokeAtReason: null };
}

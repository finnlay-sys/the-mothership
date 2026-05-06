import { useMemo, useState } from "react";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useListLedgerEntries,
  useVerifyLedger,
  type LedgerEntry,
  type LedgerEntryAction,
} from "@workspace/api-client-react";
import { Database, ShieldCheck, ShieldAlert, Download, RefreshCw } from "lucide-react";
import { format } from "date-fns";

const ACTION_OPTIONS: Array<LedgerEntryAction | ""> = [
  "", "submit", "fill", "cancel", "kill", "close", "error",
];

export function Ledger() {
  const [missionId, setMissionId] = useState<string>("");
  const [action, setAction] = useState<LedgerEntryAction | "">("");
  const [after, setAfter] = useState<string>("");
  const [before, setBefore] = useState<string>("");

  const params = useMemo(() => {
    const p: Record<string, string | number> = { limit: 500 };
    const m = parseInt(missionId, 10);
    if (Number.isFinite(m) && m > 0) p.missionId = m;
    if (action) p.action = action;
    if (after) p.after = new Date(after).toISOString();
    if (before) p.before = new Date(before).toISOString();
    return p;
  }, [missionId, action, after, before]);

  const { data, isLoading, refetch, isFetching } = useListLedgerEntries(params, {
    query: { queryKey: ["ledger-list", params] },
  });
  const verify = useVerifyLedger({
    query: { refetchOnMount: true, queryKey: ["ledger-verify"] },
  });

  const entries = data?.entries ?? [];

  const downloadExport = () => {
    // Use a fresh window navigation so the browser handles the attachment.
    window.location.href = `${import.meta.env.BASE_URL}api/ledger/export`;
  };

  return (
    <Layout>
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <Database className="w-6 h-6 text-primary" />
              <h1 className="text-2xl font-mono font-bold tracking-widest text-primary">
                LEDGER.CHAIN
              </h1>
            </div>
            <p className="text-xs text-muted-foreground font-mono tracking-wider">
              SHA-256 chained, append-only forensic record of every executed transaction.
            </p>
          </div>
          <VerifyBadge
            ok={verify.data?.ok ?? null}
            total={verify.data?.totalEntries ?? 0}
            lastHash={verify.data?.lastHash ?? null}
            brokeAt={verify.data?.brokeAtIndex ?? null}
            brokeReason={verify.data?.brokeAtReason ?? null}
            loading={verify.isFetching}
            onRefresh={() => verify.refetch()}
          />
        </div>

        <Card className="p-4 bg-card border-border">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <FilterField label="MISSION ID">
              <input
                type="number"
                placeholder="all"
                value={missionId}
                onChange={(e) => setMissionId(e.target.value)}
                className="w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-xs"
                data-testid="filter-mission-id"
              />
            </FilterField>
            <FilterField label="ACTION">
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as LedgerEntryAction | "")}
                className="w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-xs"
                data-testid="filter-action"
              >
                {ACTION_OPTIONS.map((o) => (
                  <option key={o || "all"} value={o}>{o ? o.toUpperCase() : "ALL"}</option>
                ))}
              </select>
            </FilterField>
            <FilterField label="AFTER">
              <input
                type="datetime-local"
                value={after}
                onChange={(e) => setAfter(e.target.value)}
                className="w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-xs"
                data-testid="filter-after"
              />
            </FilterField>
            <FilterField label="BEFORE">
              <input
                type="datetime-local"
                value={before}
                onChange={(e) => setBefore(e.target.value)}
                className="w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-xs"
                data-testid="filter-before"
              />
            </FilterField>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="btn-refresh-ledger">
                <RefreshCw className={`w-3 h-3 mr-1 ${isFetching ? "animate-spin" : ""}`} />
                REFRESH
              </Button>
              <Button size="sm" variant="outline" onClick={downloadExport} data-testid="btn-export-ledger">
                <Download className="w-3 h-3 mr-1" /> EXPORT
              </Button>
            </div>
          </div>
        </Card>

        {isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <Card className="bg-card border-border">
            <div className="p-3 border-b border-border flex items-center justify-between font-mono text-[10px] tracking-widest text-muted-foreground">
              <span>{entries.length} of {data?.total ?? 0} ENTRIES</span>
              <span>NEWEST AT BOTTOM (chronological)</span>
            </div>
            <div className="divide-y divide-border max-h-[70vh] overflow-y-auto">
              {entries.length === 0 ? (
                <div className="p-6 text-center font-mono text-xs text-muted-foreground">
                  NO ENTRIES MATCH THE CURRENT FILTERS.
                </div>
              ) : (
                entries.map((e) => <LedgerRow key={`${e.index}-${e.hash}`} entry={e} />)
              )}
            </div>
          </Card>
        )}
      </div>
    </Layout>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-[10px] font-mono tracking-widest text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function VerifyBadge({ ok, total, lastHash, brokeAt, brokeReason, loading, onRefresh }: {
  ok: boolean | null; total: number; lastHash: string | null;
  brokeAt: number | null; brokeReason: string | null;
  loading: boolean; onRefresh: () => void;
}) {
  const color = ok == null ? "border-border text-muted-foreground" : ok ? "border-chart-2/50 text-chart-2 bg-chart-2/5" : "border-destructive/50 text-destructive bg-destructive/5";
  const Icon = ok ? ShieldCheck : ShieldAlert;
  return (
    <div className={`px-3 py-2 rounded-sm border font-mono text-xs ${color}`} data-testid="ledger-verify-badge">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4" />
        <span className="font-bold tracking-widest">
          {ok == null ? "VERIFYING…" : ok ? "CHAIN VERIFIED" : `CHAIN BROKEN @ ${brokeAt}`}
        </span>
        <Button size="sm" variant="ghost" className="h-6 px-2" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <div className="mt-1 text-[10px] opacity-80">
        {total} ENTRIES · LAST {lastHash ? lastHash.slice(0, 12) + "…" : "—"}
        {brokeReason ? ` · ${brokeReason}` : ""}
      </div>
    </div>
  );
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const [open, setOpen] = useState(false);
  const actionColor: Record<string, string> = {
    submit: "text-chart-4",
    fill: "text-chart-2",
    cancel: "text-muted-foreground",
    kill: "text-destructive",
    close: "text-chart-5",
    error: "text-destructive",
  };
  const ts = (() => { try { return format(new Date(entry.ts), "yyyy-MM-dd HH:mm:ss"); } catch { return entry.ts; } })();
  return (
    <div className="px-3 py-2 hover:bg-secondary/40" data-testid={`ledger-row-${entry.index}`}>
      <div
        className="flex items-center gap-3 font-mono text-[11px] cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        <span className="text-muted-foreground w-12 text-right">#{entry.index}</span>
        <span className="text-muted-foreground">{ts}</span>
        <span className={`font-bold w-16 ${actionColor[entry.action] ?? "text-foreground"}`}>{entry.action.toUpperCase()}</span>
        <span className="text-foreground/80">
          {entry.missionId != null ? `MSN-${entry.missionId}` : "—"}
        </span>
        {entry.verdictRef && (
          <span className="text-foreground/60">
            {entry.verdictRef.symbol ?? "—"} · {entry.verdictRef.bias ?? "—"} · {entry.verdictRef.stance}
          </span>
        )}
        <span className="ml-auto text-muted-foreground/60">{entry.hash.slice(0, 12)}…</span>
      </div>
      {open && (
        <div
          className="mt-2 p-3 bg-background border border-border rounded-sm font-mono text-[10px] text-foreground/85 space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          {entry.missionObjective && (
            <div><span className="text-muted-foreground">objective:</span> {entry.missionObjective}</div>
          )}
          <div>
            <span className="text-muted-foreground">prevHash:</span>{" "}
            <span className="break-all">{entry.prevHash}</span>
          </div>
          <div>
            <span className="text-muted-foreground">hash:</span>{" "}
            <span className="break-all">{entry.hash}</span>
          </div>
          {entry.tradePlan != null && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">tradePlan</summary>
              <pre className="whitespace-pre-wrap break-all mt-1 text-[10px]">{JSON.stringify(entry.tradePlan, null, 2)}</pre>
            </details>
          )}
          <details open>
            <summary className="cursor-pointer text-muted-foreground">payload</summary>
            <pre className="whitespace-pre-wrap break-all mt-1 text-[10px]">{JSON.stringify(entry.payload, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

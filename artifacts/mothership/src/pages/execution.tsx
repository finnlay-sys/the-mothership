import { useEffect, useState } from "react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetExecutionConfig, useUpdateExecutionConfig, type UpdateExecutionConfigBody } from "@workspace/api-client-react";
import { Zap, Save, AlertTriangle, ShieldCheck, Trash2 } from "lucide-react";

export function Execution() {
  const { data: cfg, isLoading, refetch } = useGetExecutionConfig();
  const update = useUpdateExecutionConfig();

  const [walletAddress, setWalletAddress] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [paperMode, setPaperMode] = useState(true);
  const [useTestnet, setUseTestnet] = useState(true);
  const [notional, setNotional] = useState(200);
  const [maxNotional, setMaxNotional] = useState(1000);
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [defaultLeverage, setDefaultLeverage] = useState(3);
  const [savedTick, setSavedTick] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [operatorToken, setOperatorToken] = useState<string>(() => {
    try { return localStorage.getItem("mothership.operatorToken") ?? ""; } catch { return ""; }
  });
  const [opTokenSavedTick, setOpTokenSavedTick] = useState(0);

  const saveOperatorToken = () => {
    try {
      const v = operatorToken.trim();
      if (v) localStorage.setItem("mothership.operatorToken", v);
      else localStorage.removeItem("mothership.operatorToken");
      setOpTokenSavedTick(Date.now());
      // Refetch config so any 401/503 cleared by the new token surfaces immediately.
      void refetch();
    } catch {
      /* localStorage unavailable — token will simply not be sent */
    }
  };

  useEffect(() => {
    if (!cfg) return;
    setWalletAddress(cfg.walletAddress ?? "");
    setPaperMode(cfg.paperMode);
    setUseTestnet(cfg.useTestnet);
    setNotional(cfg.notionalPerTradeUsd);
    setMaxNotional(cfg.maxNotionalUsd);
    setMaxConcurrent(cfg.maxConcurrentTrades);
    setDefaultLeverage(cfg.defaultLeverage);
  }, [cfg]);

  const save = async () => {
    setErrorMsg(null);
    const body: Record<string, unknown> = {
      walletAddress: walletAddress.trim() || null,
      paperMode, useTestnet,
      notionalPerTradeUsd: Number(notional),
      maxNotionalUsd: Number(maxNotional),
      maxConcurrentTrades: Number(maxConcurrent),
      defaultLeverage: Number(defaultLeverage),
    };
    if (privateKey.trim()) body.privateKey = privateKey.trim();
    try {
      await update.mutateAsync({ data: body satisfies UpdateExecutionConfigBody });
      setPrivateKey("");
      setSavedTick(Date.now());
      await refetch();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const clearKey = async () => {
    if (!window.confirm("Clear stored Hyperliquid private key? Real-mode execution will be disabled until a new key is set.")) return;
    setErrorMsg(null);
    try {
      await update.mutateAsync({ data: { privateKey: "" } satisfies UpdateExecutionConfigBody });
      setPrivateKey("");
      await refetch();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Layout>
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Zap className="w-6 h-6 text-primary" />
            <h1 className="text-2xl font-mono font-bold tracking-widest text-primary">EXECUTION.CONTROL</h1>
          </div>
          <p className="text-xs text-muted-foreground font-mono tracking-wider">
            Hyperliquid wallet, paper-mode toggle, and per-account risk caps.
          </p>
        </div>

        {/* Operator-token gate. Always render so a 401/503 operator can
            unlock the surface even when the config request itself failed. */}
        <Card className="p-4 space-y-3 bg-card border-border max-w-3xl">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-xs font-mono tracking-widest text-muted-foreground">OPERATOR TOKEN</h2>
          </div>
          <p className="text-[10px] font-mono text-muted-foreground/70">
            Required in production (server env <code>EXECUTION_OPERATOR_TOKEN</code>).
            Stored locally in this browser; sent as <code>x-operator-token</code> on every execution call.
            Leave blank in dev when the server token is unset.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              className="flex-1 bg-background border border-border rounded-sm px-3 py-2 font-mono text-xs"
              placeholder="paste operator shared secret"
              value={operatorToken}
              onChange={(e) => setOperatorToken(e.target.value)}
              data-testid="input-operator-token"
            />
            <Button size="sm" variant="outline" onClick={saveOperatorToken} data-testid="btn-save-operator-token">
              SAVE
            </Button>
            {opTokenSavedTick > 0 && Date.now() - opTokenSavedTick < 4000 && (
              <span className="text-xs font-mono text-chart-2">SAVED.</span>
            )}
          </div>
        </Card>

        {isLoading || !cfg ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <Card className="p-6 space-y-6 bg-card border-border max-w-3xl">
            {/* Mode toggles */}
            <section className="space-y-3">
              <h2 className="text-xs font-mono tracking-widest text-muted-foreground">MODE</h2>
              <div className="grid grid-cols-2 gap-3">
                <ModeToggle
                  label="PAPER MODE" desc="Simulate fills against the live mark — no signed orders sent."
                  on={paperMode} setOn={setPaperMode} dangerWhenOff />
                <ModeToggle
                  label="TESTNET" desc="When OFF, signed orders go to MAINNET. Real money."
                  on={useTestnet} setOn={setUseTestnet} dangerWhenOff />
              </div>
              {!paperMode && !useTestnet && (
                <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/40 rounded-sm font-mono text-xs text-destructive">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  LIVE MAINNET. Orders will move real funds.
                </div>
              )}
            </section>

            {/* Wallet */}
            <section className="space-y-3">
              <h2 className="text-xs font-mono tracking-widest text-muted-foreground">WALLET</h2>
              <Field label="Wallet Address (0x…)" hint="Public — safe to display.">
                <input
                  className="w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-xs"
                  placeholder="0x0000000000000000000000000000000000000000"
                  value={walletAddress}
                  onChange={(e) => setWalletAddress(e.target.value)}
                  data-testid="input-wallet-address"
                />
              </Field>
              <Field
                label="Private Key (32-byte hex)"
                hint={cfg.hasPrivateKey
                  ? "A key is currently stored (encrypted). Submit a new value to rotate, or clear it below."
                  : "No key stored. Required for real-mode execution."}>
                <input
                  type="password"
                  autoComplete="off"
                  className="w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-xs"
                  placeholder={cfg.hasPrivateKey ? "•••••••••••••••• (leave blank to keep)" : "0x…"}
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  data-testid="input-private-key"
                />
              </Field>
              <div className="flex items-center gap-3 text-xs font-mono">
                {cfg.hasPrivateKey ? (
                  <span className="flex items-center gap-1 text-chart-2"><ShieldCheck className="w-3.5 h-3.5" /> KEY STORED (AES-256-GCM)</span>
                ) : (
                  <span className="text-muted-foreground">NO KEY STORED</span>
                )}
                {cfg.hasPrivateKey && (
                  <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={clearKey} data-testid="btn-clear-key">
                    <Trash2 className="w-3 h-3 mr-1" /> CLEAR KEY
                  </Button>
                )}
              </div>
            </section>

            {/* Risk caps */}
            <section className="space-y-3">
              <h2 className="text-xs font-mono tracking-widest text-muted-foreground">RISK CAPS</h2>
              <div className="grid grid-cols-2 gap-3">
                <NumberField label="Notional Per Trade ($)" value={notional} onChange={setNotional} step={50} testId="input-notional" />
                <NumberField label="Max Notional Cap ($)" value={maxNotional} onChange={setMaxNotional} step={100} testId="input-max-notional" />
                <NumberField label="Max Concurrent Trades" value={maxConcurrent} onChange={setMaxConcurrent} step={1} testId="input-max-concurrent" />
                <NumberField label="Default Leverage (x)" value={defaultLeverage} onChange={setDefaultLeverage} step={1} testId="input-leverage" />
              </div>
              {notional > maxNotional && (
                <div className="text-xs font-mono text-destructive">
                  notionalPerTradeUsd ({notional}) exceeds maxNotionalUsd cap ({maxNotional}) — execution will refuse.
                </div>
              )}
            </section>

            {errorMsg && (
              <div className="p-3 bg-destructive/10 border border-destructive/40 rounded-sm font-mono text-xs text-destructive">
                {errorMsg}
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button
                onClick={save}
                disabled={update.isPending}
                className="bg-primary text-primary-foreground font-mono tracking-wider shadow-[0_0_15px_hsl(var(--primary)/0.3)]"
                data-testid="btn-save-config"
              >
                <Save className="w-4 h-4 mr-2" />
                {update.isPending ? "SAVING…" : "SAVE CONFIG"}
              </Button>
              {savedTick > 0 && Date.now() - savedTick < 4000 && (
                <span className="text-xs font-mono text-chart-2">SAVED.</span>
              )}
            </div>
          </Card>
        )}
      </div>
    </Layout>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-[10px] font-mono tracking-widest text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="text-[10px] font-mono text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

function NumberField({ label, value, onChange, step, testId }: {
  label: string; value: number; onChange: (n: number) => void; step: number; testId?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-[10px] font-mono tracking-widest text-muted-foreground">{label}</label>
      <input
        type="number" step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-xs"
        data-testid={testId}
      />
    </div>
  );
}

function ModeToggle({ label, desc, on, setOn, dangerWhenOff }: {
  label: string; desc: string; on: boolean; setOn: (b: boolean) => void; dangerWhenOff?: boolean;
}) {
  const danger = dangerWhenOff && !on;
  return (
    <button
      type="button"
      onClick={() => setOn(!on)}
      data-testid={`toggle-${label.toLowerCase().replace(/\s+/g, '-')}`}
      className={`text-left p-3 rounded-sm border font-mono text-xs transition-all ${
        on ? "bg-chart-2/10 border-chart-2/50 text-chart-2"
           : danger ? "bg-destructive/10 border-destructive/40 text-destructive"
                    : "bg-secondary/50 border-border text-muted-foreground"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="tracking-widest font-bold">{label}</span>
        <span className="text-[10px]">{on ? "ON" : "OFF"}</span>
      </div>
      <div className="text-[10px] opacity-80">{desc}</div>
    </button>
  );
}

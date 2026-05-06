// NOTE: SSE consumption uses the browser's native EventSource. Do NOT use the
// generated `streamMarketSnapshot` React Query hook from @workspace/api-client-react —
// codegen models the SSE endpoint as a single fetch and will not deliver
// subsequent ticks.
import { useEffect, useRef, useState } from "react";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Activity, TrendingUp, TrendingDown, Wifi, WifiOff } from "lucide-react";
import { MarketChart, type MarketChartHandle } from "@/components/market-chart";

const CHART_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type ChartInterval = (typeof CHART_INTERVALS)[number];

type MarketSnapshot = {
  symbol: string;
  markPrice: number;
  oraclePrice: number;
  midPrice: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  spread: number | null;
  spreadBps: number | null;
  fundingRate: number;
  openInterest: number;
  prevDayPrice: number;
  dayVolumeUsd: number;
  changePct24h: number;
  timestamp: number;
};

const fmt = (n: number | null | undefined, dp = 2) =>
  n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

const fmtCompact = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);

export function Market() {
  const [symbolInput, setSymbolInput] = useState("ETH");
  const [activeSymbol, setActiveSymbol] = useState("ETH");
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState(0);
  const [direction, setDirection] = useState<"up" | "down" | "flat">("flat");
  const [interval, setInterval_] = useState<ChartInterval>("1m");
  const [chartError, setChartError] = useState<string | null>(null);
  // Phase 3 will read this ref to inject markers / price lines.
  const chartHandleRef = useRef<MarketChartHandle | null>(null);

  // Reset interval to default when the symbol changes.
  useEffect(() => {
    setInterval_("1m");
  }, [activeSymbol]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setConnected(false);

    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    let es: EventSource | null = null;
    let cancelled = false;

    // Pre-validate via REST so unknown symbols show a clean error instead of
    // a silent EventSource reconnect loop.
    (async () => {
      try {
        const r = await fetch(`${base}/api/market/${encodeURIComponent(activeSymbol)}`);
        if (cancelled) return;
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body?.error || `HTTP ${r.status}`);
          return;
        }
        const initial = (await r.json()) as MarketSnapshot;
        if (cancelled) return;
        setSnapshot(initial);
        setTick(1);

        const url = `${base}/api/market/${encodeURIComponent(activeSymbol)}/stream`;
        es = new EventSource(url);
        attachHandlers(es);
      } catch {
        if (!cancelled) setError("Network error contacting market service");
      }
    })();

    function attachHandlers(source: EventSource) {

      source.onopen = () => setConnected(true);
      source.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data) as MarketSnapshot;
          // Guard against late ticks from a previous symbol session arriving
          // after a fast symbol switch — they would otherwise feed a stale
          // price into the chart's live-bar mutator.
          if (data.symbol && data.symbol.toUpperCase() !== activeSymbol.toUpperCase()) {
            return;
          }
          setSnapshot((prev) => {
            if (prev != null && data.markPrice > prev.markPrice) setDirection("up");
            else if (prev != null && data.markPrice < prev.markPrice) setDirection("down");
            else setDirection("flat");
            return data;
          });
          setTick((t) => t + 1);
          setError(null);
        } catch (e) {
          console.error("parse error", e);
        }
      };
      source.addEventListener("upstream_error", (evt: Event) => {
        try {
          const data = JSON.parse((evt as MessageEvent).data || "{}");
          if (data?.message) setError(`UPSTREAM · ${data.message}`);
        } catch {
          /* ignore */
        }
      });
      source.onerror = () => {
        setConnected(false);
      };
    }

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [activeSymbol]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = symbolInput.trim().toUpperCase();
    if (v) setActiveSymbol(v);
  };

  const upClass = "text-chart-2";
  const downClass = "text-destructive";
  const changePos = (snapshot?.changePct24h ?? 0) >= 0;
  const fundingPos = (snapshot?.fundingRate ?? 0) >= 0;

  return (
    <Layout>
      <div className="flex flex-col h-full overflow-hidden">
        <header className="border-b border-border bg-card shrink-0 p-6 flex flex-col md:flex-row gap-6 justify-between items-start md:items-center">
          <div>
            <h1 className="text-3xl font-mono font-bold text-primary tracking-widest uppercase">MARKET.FEED</h1>
            <p className="font-mono text-xs text-muted-foreground mt-1">
              HYPERLIQUID PERP · LIVE L1 + FUNDING · READ-ONLY
            </p>
          </div>
          <form onSubmit={submit} className="flex gap-2 items-center">
            <input
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              placeholder="SYMBOL (e.g. ETH)"
              data-testid="input-symbol"
              className="bg-background border border-border rounded-sm px-3 py-2 font-mono text-sm uppercase tracking-widest text-primary focus:outline-none focus:border-primary w-48"
            />
            <Button type="submit" className="font-mono font-bold rounded-sm" data-testid="btn-load-symbol">
              LOAD
            </Button>
          </form>
        </header>

        <div className="flex-1 overflow-y-auto p-6 bg-background">
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-2xl font-mono font-bold text-primary tracking-widest">{activeSymbol}-PERP</h2>
                <span
                  className={`flex items-center gap-1 px-2 py-0.5 text-xs font-mono border rounded-sm uppercase tracking-wider ${
                    connected
                      ? "bg-chart-2/10 text-chart-2 border-chart-2/50"
                      : "bg-destructive/10 text-destructive border-destructive/50"
                  }`}
                >
                  {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                  {connected ? "LIVE" : "OFFLINE"}
                </span>
                {tick > 0 && (
                  <span className="font-mono text-xs text-muted-foreground">TICK #{tick}</span>
                )}
              </div>
            </div>

            {error && (
              <Card className="border-destructive/50 bg-destructive/5 p-4 font-mono text-sm text-destructive">
                ERR · {error}
              </Card>
            )}

            {!snapshot && !error && (
              <Card className="border-border bg-card p-12 flex flex-col items-center justify-center text-muted-foreground font-mono">
                <Activity className="w-8 h-8 animate-spin mb-3 text-primary" />
                <span className="text-sm tracking-widest">CONNECTING TO HYPERLIQUID…</span>
              </Card>
            )}

            {snapshot && (
              <>
                {/* Price hero */}
                <Card className="border-primary/30 bg-card p-6 shadow-[0_0_24px_hsl(var(--primary)/0.1)]">
                  <div className="flex items-baseline justify-between flex-wrap gap-4">
                    <div>
                      <div className="font-mono text-xs text-muted-foreground tracking-widest mb-1">MARK PRICE</div>
                      <div
                        data-testid="mark-price"
                        className={`text-5xl font-mono font-bold tracking-tight transition-colors duration-300 ${
                          direction === "up" ? upClass : direction === "down" ? downClass : "text-foreground"
                        }`}
                      >
                        ${fmt(snapshot.markPrice, snapshot.markPrice < 10 ? 4 : 2)}
                      </div>
                    </div>
                    <div className={`flex items-center gap-2 font-mono text-xl ${changePos ? upClass : downClass}`}>
                      {changePos ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
                      <span>
                        {changePos ? "+" : ""}
                        {fmt(snapshot.changePct24h, 2)}%
                      </span>
                      <span className="text-xs text-muted-foreground tracking-widest ml-2">24H</span>
                    </div>
                  </div>
                </Card>

                {/* Candlestick chart */}
                <Card className="border-border bg-card overflow-hidden">
                  <div className="bg-secondary/40 px-4 py-2 border-b border-border flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-primary tracking-widest uppercase">
                      PRICE.CHART
                    </span>
                    <div className="flex gap-1" role="group" aria-label="Chart interval">
                      {CHART_INTERVALS.map((iv) => (
                        <button
                          key={iv}
                          type="button"
                          data-testid={`btn-interval-${iv}`}
                          onClick={() => setInterval_(iv)}
                          className={`px-2 py-0.5 font-mono text-[10px] tracking-widest border rounded-sm uppercase transition-colors ${
                            interval === iv
                              ? "bg-primary/20 text-primary border-primary/60"
                              : "bg-background text-muted-foreground border-border hover:text-primary hover:border-primary/40"
                          }`}
                        >
                          {iv}
                        </button>
                      ))}
                    </div>
                  </div>
                  {chartError && (
                    <div className="px-4 py-2 font-mono text-xs text-destructive bg-destructive/5 border-b border-destructive/30">
                      CHART · {chartError}
                    </div>
                  )}
                  <div className="p-2">
                    <MarketChart
                      ref={chartHandleRef}
                      symbol={activeSymbol}
                      interval={interval}
                      latestPrice={snapshot.markPrice}
                      latestTimestamp={snapshot.timestamp}
                      onError={setChartError}
                    />
                  </div>
                </Card>

                {/* L1 Order Book */}
                <Card className="border-border bg-card overflow-hidden">
                  <div className="bg-secondary/40 px-4 py-2 border-b border-border">
                    <span className="font-mono text-xs font-bold text-primary tracking-widest uppercase">L1 ORDER BOOK</span>
                  </div>
                  <div className="grid grid-cols-3 divide-x divide-border">
                    <div className="p-4">
                      <div className="font-mono text-xs text-muted-foreground tracking-widest mb-1">BEST BID</div>
                      <div className={`text-2xl font-mono font-bold ${upClass}`}>${fmt(snapshot.bid, snapshot.markPrice < 10 ? 4 : 2)}</div>
                      <div className="font-mono text-xs text-muted-foreground mt-1">SIZE {fmt(snapshot.bidSize, 4)}</div>
                    </div>
                    <div className="p-4">
                      <div className="font-mono text-xs text-muted-foreground tracking-widest mb-1">SPREAD</div>
                      <div className="text-2xl font-mono font-bold text-foreground">${fmt(snapshot.spread, 4)}</div>
                      <div className="font-mono text-xs text-muted-foreground mt-1">{fmt(snapshot.spreadBps, 2)} BPS</div>
                    </div>
                    <div className="p-4">
                      <div className="font-mono text-xs text-muted-foreground tracking-widest mb-1">BEST ASK</div>
                      <div className={`text-2xl font-mono font-bold ${downClass}`}>${fmt(snapshot.ask, snapshot.markPrice < 10 ? 4 : 2)}</div>
                      <div className="font-mono text-xs text-muted-foreground mt-1">SIZE {fmt(snapshot.askSize, 4)}</div>
                    </div>
                  </div>
                </Card>

                {/* Funding + OI + Volume */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Card className="border-border bg-card p-4">
                    <div className="font-mono text-xs text-muted-foreground tracking-widest mb-2">FUNDING RATE (1H)</div>
                    <div className={`text-2xl font-mono font-bold ${fundingPos ? upClass : downClass}`}>
                      {fundingPos ? "+" : ""}
                      {(snapshot.fundingRate * 100).toFixed(4)}%
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground mt-1 tracking-widest">
                      ANNUALIZED {(snapshot.fundingRate * 24 * 365 * 100).toFixed(2)}%
                    </div>
                  </Card>
                  <Card className="border-border bg-card p-4">
                    <div className="font-mono text-xs text-muted-foreground tracking-widest mb-2">OPEN INTEREST</div>
                    <div className="text-2xl font-mono font-bold text-foreground">{fmtCompact(snapshot.openInterest)}</div>
                    <div className="font-mono text-[10px] text-muted-foreground mt-1 tracking-widest">{activeSymbol}</div>
                  </Card>
                  <Card className="border-border bg-card p-4">
                    <div className="font-mono text-xs text-muted-foreground tracking-widest mb-2">24H VOLUME</div>
                    <div className="text-2xl font-mono font-bold text-foreground">${fmtCompact(snapshot.dayVolumeUsd)}</div>
                    <div className="font-mono text-[10px] text-muted-foreground mt-1 tracking-widest">USD NOTIONAL</div>
                  </Card>
                </div>

                {/* Reference prices */}
                <Card className="border-border bg-card p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="font-mono text-[10px] text-muted-foreground tracking-widest">ORACLE</div>
                    <div className="font-mono text-sm text-foreground">${fmt(snapshot.oraclePrice, snapshot.markPrice < 10 ? 4 : 2)}</div>
                  </div>
                  <div>
                    <div className="font-mono text-[10px] text-muted-foreground tracking-widest">MID</div>
                    <div className="font-mono text-sm text-foreground">${fmt(snapshot.midPrice, snapshot.markPrice < 10 ? 4 : 2)}</div>
                  </div>
                  <div>
                    <div className="font-mono text-[10px] text-muted-foreground tracking-widest">PREV CLOSE 24H</div>
                    <div className="font-mono text-sm text-foreground">${fmt(snapshot.prevDayPrice, snapshot.markPrice < 10 ? 4 : 2)}</div>
                  </div>
                  <div>
                    <div className="font-mono text-[10px] text-muted-foreground tracking-widest">SNAPSHOT TS</div>
                    <div className="font-mono text-sm text-foreground">{new Date(snapshot.timestamp).toLocaleTimeString()}</div>
                  </div>
                </Card>
              </>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}

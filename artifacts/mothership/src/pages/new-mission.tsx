import { Layout } from "@/components/layout";
import { useCreateMission, useListMarketSymbols } from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLocation } from "wouter";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Terminal, AlertTriangle, TrendingUp, LineChart, Zap, Clock } from "lucide-react";
import { MarketChart } from "@/components/market-chart";

const schema = z.object({
  primeObjective: z.string().min(10, "Objective must be at least 10 characters long").max(1000, "Objective too long"),
  targetSymbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^$|^[A-Z0-9]{1,15}$/, "Symbol must be 1-15 alphanumeric chars (or empty)")
    .optional(),
  // scalp = 2-cycle cap, reasoning_effort=minimal — confident thesis in ~20s.
  // swing = the pre-Task-31 4-cycle cadence with no reasoning cap, suitable
  // for slower setups where thoroughness matters more than wall-clock.
  speedMode: z.enum(["scalp", "swing"]).default("scalp"),
});

type FormValues = z.infer<typeof schema>;

const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;

export function NewMission() {
  const [, setLocation] = useLocation();
  const createMission = useCreateMission();
  const { data: symbolsData } = useListMarketSymbols();
  const allSymbols = symbolsData?.symbols ?? [];

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      primeObjective: "",
      targetSymbol: "",
      speedMode: "scalp",
    },
  });

  const symbolValue = (form.watch("targetSymbol") ?? "").toUpperCase();
  const [serverError, setServerError] = useState<string | null>(null);
  const [interval, setInterval_] = useState<string>("15m");
  const [chartError, setChartError] = useState<string | null>(null);
  const [liveMarkPrice, setLiveMarkPrice] = useState<number | null>(null);
  const [liveMarkTs, setLiveMarkTs] = useState<number | null>(null);

  const isValidSymbol = useMemo(
    () => symbolValue.length > 0 && allSymbols.includes(symbolValue),
    [symbolValue, allSymbols],
  );

  // Clear stale chart error whenever symbol or interval changes — avoids
  // showing the previous symbol's error banner during transitions.
  useEffect(() => {
    setChartError(null);
  }, [symbolValue, interval]);

  // Live mark-price SSE for the selected symbol. Reuses the same
  // /api/market/{symbol}/stream endpoint that mission-detail uses, and
  // feeds latestPrice/latestTimestamp into MarketChart so the rightmost
  // candle ticks in real time.
  useEffect(() => {
    if (!isValidSymbol) {
      setLiveMarkPrice(null);
      setLiveMarkTs(null);
      return;
    }
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    const url = `${base}/api/market/${encodeURIComponent(symbolValue)}/stream`;
    const es = new EventSource(url);
    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as { symbol?: string; markPrice?: number };
        if (data.symbol && data.symbol.toUpperCase() !== symbolValue) return;
        if (typeof data.markPrice === "number" && Number.isFinite(data.markPrice)) {
          setLiveMarkPrice(data.markPrice);
          setLiveMarkTs(Date.now());
        }
      } catch {
        /* ignore parse errors */
      }
    };
    return () => { es.close(); };
  }, [isValidSymbol, symbolValue]);

  // Live "did you mean" suggestions for the symbol field — first 8 prefix matches.
  const suggestions = useMemo(() => {
    if (!symbolValue || symbolValue.length < 1) return [];
    return allSymbols.filter((s) => s.startsWith(symbolValue) && s !== symbolValue).slice(0, 8);
  }, [symbolValue, allSymbols]);

  const onSubmit = (data: FormValues) => {
    setServerError(null);
    const sym = (data.targetSymbol ?? "").trim().toUpperCase();
    const payload = {
      primeObjective: data.primeObjective,
      speedMode: data.speedMode,
      ...(sym ? { targetSymbol: sym } : {}),
    };

    createMission.mutate(
      { data: payload },
      {
        onSuccess: (mission) => {
          setLocation(`/missions/${mission.id}`);
        },
        onError: async (err: unknown) => {
          const e = err as { response?: { data?: { error?: string } }; message?: string };
          setServerError(e.response?.data?.error ?? e.message ?? "Mission creation failed");
        },
      }
    );
  };

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto w-full">
        <header className="mb-8 border-b border-border pb-4">
          <h1 className="text-2xl font-mono font-bold text-primary tracking-widest uppercase flex items-center">
            <Terminal className="w-6 h-6 mr-3" />
            Issue Directive
          </h1>
          <p className="text-muted-foreground font-mono text-sm mt-2">INITIALIZE NEW SOVEREIGN AI MISSION</p>
        </header>

        <div className="bg-card border border-border p-6 rounded-sm relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary to-transparent opacity-50"></div>

          <div className="flex items-start mb-6 p-4 bg-chart-4/10 border border-chart-4/30 rounded-sm text-chart-4 font-mono text-sm">
            <AlertTriangle className="w-5 h-5 mr-3 shrink-0" />
            <p>WARNING: Once initialized, the Worker agent will autonomously pursue this objective until the Observer escalates to Queen for Thesis Lock. Ensure objective is unambiguous.</p>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="targetSymbol"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-primary uppercase tracking-widest flex items-center gap-2">
                      <TrendingUp className="w-3.5 h-3.5" />
                      Target Symbol <span className="text-muted-foreground text-[10px] tracking-widest">· OPTIONAL</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="ETH, BTC, SOL..."
                        autoComplete="off"
                        list="symbol-list"
                        {...field}
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                        className="font-mono bg-secondary/50 border-border focus-visible:ring-primary rounded-sm uppercase tracking-widest"
                        data-testid="input-target-symbol"
                      />
                    </FormControl>
                    <datalist id="symbol-list">
                      {allSymbols.map((s) => <option key={s} value={s} />)}
                    </datalist>
                    {suggestions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1" data-testid="symbol-suggestions">
                        {suggestions.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => form.setValue("targetSymbol", s, { shouldValidate: true })}
                            className="px-2 py-0.5 font-mono text-[10px] tracking-widest border border-border rounded-sm uppercase text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] tracking-widest text-muted-foreground font-mono mt-1 uppercase">
                      Hyperliquid perp · live market context will be injected into every agent.
                    </p>
                    <FormMessage className="font-mono text-destructive" />
                  </FormItem>
                )}
              />

              {/* Live chart preview — always-on placeholder for layout stability,
                  swaps to a live MarketChart when the typed symbol matches a
                  known Hyperliquid symbol. */}
              <div
                className="border border-border rounded-sm bg-secondary/30 overflow-hidden"
                data-testid="chart-preview-card"
              >
                <div className="flex items-center justify-between bg-secondary/40 px-3 py-2 border-b border-border">
                  <span className="font-mono text-[11px] tracking-widest text-primary uppercase flex items-center gap-2">
                    <LineChart className="w-3.5 h-3.5" />
                    {isValidSymbol ? `${symbolValue}-PERP · LIVE` : "PRICE PREVIEW"}
                  </span>
                  <div className="flex gap-0.5" data-testid="preview-interval-selector">
                    {INTERVALS.map((iv) => (
                      <button
                        key={iv}
                        type="button"
                        data-testid={`btn-interval-${iv}`}
                        disabled={!isValidSymbol}
                        onClick={() => setInterval_(iv)}
                        className={`px-2 py-0.5 font-mono text-[10px] tracking-widest border rounded-sm uppercase transition-colors ${
                          isValidSymbol && interval === iv
                            ? "bg-primary/20 text-primary border-primary/60"
                            : "bg-background text-muted-foreground border-border hover:text-primary hover:border-primary/40"
                        } disabled:opacity-40 disabled:hover:text-muted-foreground disabled:hover:border-border`}
                      >
                        {iv}
                      </button>
                    ))}
                  </div>
                </div>
                {isValidSymbol && chartError && (
                  <div className="px-4 py-2 font-mono text-xs text-destructive bg-destructive/5 border-b border-destructive/30">
                    CHART · {chartError}
                  </div>
                )}
                <div className="p-2">
                  {isValidSymbol ? (
                    <MarketChart
                      symbol={symbolValue}
                      interval={interval}
                      latestPrice={liveMarkPrice}
                      latestTimestamp={liveMarkTs}
                      onError={setChartError}
                    />
                  ) : (
                    <div
                      className="w-full h-[360px] flex flex-col items-center justify-center text-muted-foreground font-mono text-xs tracking-widest text-center px-6"
                      data-testid="chart-preview-placeholder"
                    >
                      <LineChart className="w-8 h-8 mb-3 opacity-40" />
                      AWAITING VALID TICKER
                      <span className="text-[10px] mt-1 opacity-70">
                        TYPE OR PICK A SYMBOL ABOVE TO LOAD LIVE PRICE ACTION
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <FormField
                control={form.control}
                name="speedMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-primary uppercase tracking-widest flex items-center gap-2">
                      <Zap className="w-3.5 h-3.5" />
                      Debate Cadence
                    </FormLabel>
                    <FormControl>
                      <div className="grid grid-cols-2 gap-2" data-testid="speed-mode-toggle">
                        <button
                          type="button"
                          data-testid="btn-speed-scalp"
                          onClick={() => field.onChange("scalp")}
                          className={`p-3 border rounded-sm font-mono text-left transition-colors ${
                            field.value === "scalp"
                              ? "bg-primary/15 border-primary text-primary shadow-[0_0_15px_hsl(var(--primary)/0.2)]"
                              : "bg-secondary/40 border-border text-muted-foreground hover:text-primary hover:border-primary/40"
                          }`}
                        >
                          <div className="flex items-center gap-2 text-xs tracking-widest uppercase mb-1">
                            <Zap className="w-3.5 h-3.5" />
                            Scalp
                            <span className="ml-auto text-[10px] opacity-70">~20s</span>
                          </div>
                          <div className="text-[10px] tracking-wide opacity-80 normal-case">
                            2-cycle cap, minimal reasoning. For 1m–5m perp setups.
                          </div>
                        </button>
                        <button
                          type="button"
                          data-testid="btn-speed-swing"
                          onClick={() => field.onChange("swing")}
                          className={`p-3 border rounded-sm font-mono text-left transition-colors ${
                            field.value === "swing"
                              ? "bg-primary/15 border-primary text-primary shadow-[0_0_15px_hsl(var(--primary)/0.2)]"
                              : "bg-secondary/40 border-border text-muted-foreground hover:text-primary hover:border-primary/40"
                          }`}
                        >
                          <div className="flex items-center gap-2 text-xs tracking-widest uppercase mb-1">
                            <Clock className="w-3.5 h-3.5" />
                            Swing
                            <span className="ml-auto text-[10px] opacity-70">~3min</span>
                          </div>
                          <div className="text-[10px] tracking-wide opacity-80 normal-case">
                            4-cycle thoroughness, full reasoning. For slower setups.
                          </div>
                        </button>
                      </div>
                    </FormControl>
                    <FormMessage className="font-mono text-destructive" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="primeObjective"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-primary uppercase tracking-widest">Prime Objective</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Enter the mission mandate..."
                        className="min-h-[200px] font-mono bg-secondary/50 border-border focus-visible:ring-primary rounded-sm resize-y"
                        {...field}
                        data-testid="input-objective"
                      />
                    </FormControl>
                    <FormMessage className="font-mono text-destructive" />
                  </FormItem>
                )}
              />

              {serverError && (
                <div className="p-3 bg-destructive/10 border border-destructive/40 text-destructive font-mono text-xs rounded-sm">
                  ERR · {serverError}
                </div>
              )}

              <div className="flex justify-end pt-4 border-t border-border">
                <Button
                  type="submit"
                  disabled={createMission.isPending}
                  className="font-mono uppercase tracking-widest rounded-sm shadow-[0_0_15px_hsl(var(--primary)/0.2)]"
                  data-testid="btn-submit"
                >
                  {createMission.isPending ? "INITIALIZING..." : "INITIALIZE MISSION"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </div>
    </Layout>
  );
}

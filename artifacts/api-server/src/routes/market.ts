import { Router } from "express";
import {
  getMarketSnapshot,
  isValidPerpSymbol,
  getPerpUniverse,
  getCandleSnapshot,
  isValidCandleInterval,
  CANDLE_INTERVALS,
} from "../lib/hyperliquid-client";

const router = Router();

router.get("/market/symbols", async (req, res) => {
  try {
    const universe = await getPerpUniverse();
    res.json({ symbols: Array.from(universe).sort() });
  } catch (err) {
    req.log.error({ err }, "listMarketSymbols error");
    res.status(502).json({ error: "Upstream market data unavailable" });
  }
});

router.get("/market/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  if (!symbol || !/^[A-Za-z0-9]{1,20}$/.test(symbol)) {
    res.status(400).json({ error: "Invalid symbol format" });
    return;
  }
  try {
    if (!(await isValidPerpSymbol(symbol))) {
      res.status(400).json({ error: `Unknown perp symbol: ${symbol.toUpperCase()}` });
      return;
    }
    const snapshot = await getMarketSnapshot(symbol);
    res.json(snapshot);
  } catch (err) {
    req.log.error({ err, symbol }, "getMarketSnapshot error");
    res.status(502).json({ error: "Upstream market data unavailable" });
  }
});

router.get("/market/:symbol/candles", async (req, res) => {
  const symbol = req.params.symbol;
  if (!symbol || !/^[A-Za-z0-9]{1,20}$/.test(symbol)) {
    res.status(400).json({ error: "Invalid symbol format" });
    return;
  }
  const interval = String(req.query["interval"] ?? "1m");
  if (!isValidCandleInterval(interval)) {
    res
      .status(400)
      .json({ error: `Invalid interval. Allowed: ${CANDLE_INTERVALS.join(", ")}` });
    return;
  }
  const limitRaw = Number(req.query["limit"] ?? 500);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 1000) {
    res.status(400).json({ error: "Invalid limit. Must be an integer between 1 and 1000." });
    return;
  }
  try {
    if (!(await isValidPerpSymbol(symbol))) {
      res.status(400).json({ error: `Unknown perp symbol: ${symbol.toUpperCase()}` });
      return;
    }
    const candles = await getCandleSnapshot(symbol, interval, limitRaw);
    res.json({ symbol: symbol.toUpperCase(), interval, candles });
  } catch (err) {
    req.log.error({ err, symbol, interval }, "getCandleSnapshot error");
    res.status(502).json({ error: "Upstream market data unavailable" });
  }
});

router.get("/market/:symbol/stream", async (req, res) => {
  const symbol = req.params.symbol;
  if (!symbol || !/^[A-Za-z0-9]{1,20}$/.test(symbol)) {
    res.status(400).json({ error: "Invalid symbol format" });
    return;
  }

  try {
    const valid = await isValidPerpSymbol(symbol);
    if (!valid) {
      res.status(400).json({ error: `Unknown perp symbol: ${symbol.toUpperCase()}` });
      return;
    }
  } catch (err) {
    req.log.error({ err, symbol }, "stream symbol validation failed");
    res.status(502).json({ error: "Upstream market data unavailable" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const tick = async () => {
    try {
      const snapshot = await getMarketSnapshot(symbol);
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    } catch (err) {
      // App-level upstream error — use a custom event name so the browser's
      // EventSource `error` handler (transport channel) is not triggered.
      res.write(
        `event: upstream_error\ndata: ${JSON.stringify({
          message: err instanceof Error ? err.message : "unknown",
        })}\n\n`,
      );
    }
  };

  await tick();
  while (!closed) {
    await new Promise((r) => setTimeout(r, 2000));
    if (closed) break;
    await tick();
  }
  res.end();
});

export default router;

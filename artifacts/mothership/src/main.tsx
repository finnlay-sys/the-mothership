import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setOperatorTokenGetter } from "@workspace/api-client-react";

// Inject the per-browser operator token (set on EXECUTION.CONTROL) into every
// API call as `x-operator-token`. The api-server gates the live-trading
// execution surface with this header when EXECUTION_OPERATOR_TOKEN is
// configured (mandatory in production). Stored in localStorage so the
// operator only enters it once per browser.
setOperatorTokenGetter(() => {
  try {
    return localStorage.getItem("mothership.operatorToken");
  } catch {
    return null;
  }
});

// lightweight-charts v5.1.0 has an internal time-axis repaint timer that
// continues to fire for ~10s after `chart.remove()` if a paint happens to be
// queued at disposal time, throwing "Object is disposed" against the
// already-destroyed canvas. Those throws are harmless (the live chart is
// always a different instance) but they trip Vite's runtime-error overlay and
// flood the console. Filter just this exact message — every other error still
// surfaces normally.
const isChartDisposedError = (msg: unknown): boolean =>
  typeof msg === "string" && msg.includes("Object is disposed");

// Register in the CAPTURE phase so we run before Vite/Replit's runtime-error
// overlay listener (which is registered in the bubble phase by the dev plugin).
// stopImmediatePropagation in capture phase prevents both capture and bubble
// listeners from receiving the event.
window.addEventListener(
  "error",
  (e) => {
    if (isChartDisposedError(e.error?.message) || isChartDisposedError(e.message)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true,
);
window.addEventListener(
  "unhandledrejection",
  (e) => {
    const reason = e.reason as { message?: unknown } | string | undefined;
    const msg =
      typeof reason === "string" ? reason : reason && typeof reason === "object" ? reason.message : undefined;
    if (isChartDisposedError(msg)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true,
);

createRoot(document.getElementById("root")!).render(<App />);

// Strict schema for chart annotations emitted by Synthesizer and Queen agents.
// Fed to OpenAI as a structured-output JSON schema so the model cannot return
// malformed/free-form annotations. Frontend consumes via the chartHandleRef
// (lightweight-charts setMarkers + createPriceLine).

export const MARKER_KINDS = ["entry", "exit", "stop", "take_profit", "signal", "note"] as const;
export const MARKER_POSITIONS = ["aboveBar", "belowBar", "inBar"] as const;
export const MARKER_SHAPES = ["arrowUp", "arrowDown", "circle", "square"] as const;
export const MARKER_COLORS = ["cyan", "red", "amber", "muted"] as const;

export const PRICE_LINE_KINDS = ["entry", "stop", "take_profit", "level"] as const;
export const PRICE_LINE_COLORS = ["cyan", "red", "amber", "muted"] as const;

export type ChartMarker = {
  kind: (typeof MARKER_KINDS)[number];
  timeUtcSec: number;
  position: (typeof MARKER_POSITIONS)[number];
  shape: (typeof MARKER_SHAPES)[number];
  color: (typeof MARKER_COLORS)[number];
  text: string;
};

export type ChartPriceLine = {
  kind: (typeof PRICE_LINE_KINDS)[number];
  price: number;
  color: (typeof PRICE_LINE_COLORS)[number];
  label: string;
};

export type ChartAnnotations = {
  markers: ChartMarker[];
  priceLines: ChartPriceLine[];
};

// JSON Schema literal handed to OpenAI for `response_format: { type: "json_schema", strict: true }`.
// Strict mode requires every key in `properties` to appear in `required` and `additionalProperties: false`.
export function structuredAnnotationSchema(payloadKey: "proposal" | "thesisLock") {
  return {
    name: "chart_annotated_proposal",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        [payloadKey]: { type: "string" },
        annotations: {
          type: "object",
          additionalProperties: false,
          properties: {
            markers: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", enum: [...MARKER_KINDS] },
                  timeUtcSec: { type: "integer", minimum: 0 },
                  position: { type: "string", enum: [...MARKER_POSITIONS] },
                  shape: { type: "string", enum: [...MARKER_SHAPES] },
                  color: { type: "string", enum: [...MARKER_COLORS] },
                  text: { type: "string", maxLength: 80 },
                },
                required: ["kind", "timeUtcSec", "position", "shape", "color", "text"],
              },
            },
            priceLines: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", enum: [...PRICE_LINE_KINDS] },
                  price: { type: "number" },
                  color: { type: "string", enum: [...PRICE_LINE_COLORS] },
                  label: { type: "string", maxLength: 40 },
                },
                required: ["kind", "price", "color", "label"],
              },
            },
          },
          required: ["markers", "priceLines"],
        },
      },
      required: [payloadKey, "annotations"],
    },
  } as const;
}

function isMarker(v: unknown): v is ChartMarker {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.kind === "string" && (MARKER_KINDS as readonly string[]).includes(m.kind) &&
    typeof m.timeUtcSec === "number" && Number.isFinite(m.timeUtcSec) && m.timeUtcSec >= 0 &&
    typeof m.position === "string" && (MARKER_POSITIONS as readonly string[]).includes(m.position) &&
    typeof m.shape === "string" && (MARKER_SHAPES as readonly string[]).includes(m.shape) &&
    typeof m.color === "string" && (MARKER_COLORS as readonly string[]).includes(m.color) &&
    typeof m.text === "string" && m.text.length <= 80
  );
}

function isPriceLine(v: unknown): v is ChartPriceLine {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.kind === "string" && (PRICE_LINE_KINDS as readonly string[]).includes(p.kind) &&
    typeof p.price === "number" && Number.isFinite(p.price) &&
    typeof p.color === "string" && (PRICE_LINE_COLORS as readonly string[]).includes(p.color) &&
    typeof p.label === "string" && p.label.length <= 40
  );
}

// Defensive parse — returns null if the structured response is malformed
// rather than throwing, so a bad annotation doesn't break the debate cycle.
export function parseAnnotations(raw: unknown): ChartAnnotations | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const markers = Array.isArray(r.markers) ? r.markers.filter(isMarker).slice(0, 20) : [];
  const priceLines = Array.isArray(r.priceLines) ? r.priceLines.filter(isPriceLine).slice(0, 10) : [];
  return { markers, priceLines };
}

export type AgentEvent = {
  type:
    | "worker_proposal"
    | "observer_audit"
    | "queen_checkpoint"
    | "queen_guidance"
    | "cycle_complete"
    | "chart_annotation"
    | "cost_tick"
    | "deadlock"
    | "done"
    | "error";
  data: Record<string, unknown>;
};

export type SendEvent = (event: AgentEvent) => void;

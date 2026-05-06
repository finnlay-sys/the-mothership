import { MissionStatusProperty } from "@workspace/api-client-react";

export function StatusBadge({ status }: { status: string }) {
  let color = "";
  switch (status) {
    case "pending":
      color = "bg-muted text-muted-foreground border-muted-foreground/30";
      break;
    case "running":
      color = "bg-chart-4/10 text-chart-4 border-chart-4/50 shadow-[0_0_8px_hsl(var(--chart-4)/0.3)] animate-pulse";
      break;
    case "awaiting_queen":
      color = "bg-chart-5/10 text-chart-5 border-chart-5/50 shadow-[0_0_8px_hsl(var(--chart-5)/0.3)]";
      break;
    case "awaiting_intervention":
      color = "bg-chart-3/10 text-chart-3 border-chart-3/50 shadow-[0_0_8px_hsl(var(--chart-3)/0.3)] animate-pulse";
      break;
    case "locked":
      color = "bg-primary/10 text-primary border-primary/50 shadow-[0_0_8px_hsl(var(--primary)/0.3)]";
      break;
    case "executing":
      color = "bg-chart-4/10 text-chart-4 border-chart-4/50 shadow-[0_0_8px_hsl(var(--chart-4)/0.3)] animate-pulse";
      break;
    case "completed":
      color = "bg-chart-2/10 text-chart-2 border-chart-2/50";
      break;
    case "vetoed":
      color = "bg-destructive/10 text-destructive border-destructive/50 shadow-[0_0_8px_hsl(var(--destructive)/0.3)]";
      break;
    case "aborted":
      color = "bg-destructive/10 text-destructive border-destructive/50";
      break;
    default:
      color = "bg-muted text-muted-foreground border-muted-foreground/30";
  }

  return (
    <span className={`px-2 py-0.5 text-xs font-mono border rounded-sm ${color} uppercase tracking-wider`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

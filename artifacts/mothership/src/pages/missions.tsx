import { Layout } from "@/components/layout";
import { StatusBadge } from "@/components/status-badge";
import { useListMissions } from "@workspace/api-client-react";
import { Link } from "wouter";
import { format } from "date-fns";
import { Plus, Target } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export function Missions() {
  const { data: missions, isLoading } = useListMissions();

  return (
    <Layout>
      <div className="p-6 h-full flex flex-col">
        <header className="mb-6 flex justify-between items-end border-b border-border pb-4 shrink-0">
          <div>
            <h1 className="text-2xl font-mono font-bold text-primary tracking-widest uppercase">Missions Log</h1>
            <p className="text-muted-foreground font-mono text-sm mt-2">ACTIVE AND ARCHIVED DIRECTIVES</p>
          </div>
          <Link href="/missions/new" className="inline-flex items-center justify-center px-4 py-2 font-mono text-sm font-bold bg-primary text-primary-foreground rounded-sm hover:bg-primary/90 transition-colors shadow-[0_0_15px_hsl(var(--primary)/0.3)] hover:shadow-[0_0_20px_hsl(var(--primary)/0.5)]" data-testid="btn-new-mission">
            <Plus className="w-4 h-4 mr-2" />
            NEW DIRECTIVE
          </Link>
        </header>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm text-left border-collapse font-mono">
            <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 sticky top-0 z-10 backdrop-blur-sm">
              <tr>
                <th className="px-4 py-3 font-normal border-b border-border">ID</th>
                <th className="px-4 py-3 font-normal border-b border-border">Objective</th>
                <th className="px-4 py-3 font-normal border-b border-border">Status</th>
                <th className="px-4 py-3 font-normal border-b border-border text-right">Cycles</th>
                <th
                  className="px-4 py-3 font-normal border-b border-border text-right"
                  title="Cumulative LLM spend per mission. gpt-5-mini · $0.25/M in · $2/M out (reasoning billed as out)."
                >
                  Cost
                </th>
                <th className="px-4 py-3 font-normal border-b border-border">Updated</th>
                <th className="px-4 py-3 font-normal border-b border-border text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-border">
                    <td className="px-4 py-4"><Skeleton className="h-4 w-8 bg-secondary" /></td>
                    <td className="px-4 py-4"><Skeleton className="h-4 w-64 bg-secondary" /></td>
                    <td className="px-4 py-4"><Skeleton className="h-6 w-24 bg-secondary" /></td>
                    <td className="px-4 py-4"><Skeleton className="h-4 w-8 bg-secondary ml-auto" /></td>
                    <td className="px-4 py-4"><Skeleton className="h-4 w-12 bg-secondary ml-auto" /></td>
                    <td className="px-4 py-4"><Skeleton className="h-4 w-24 bg-secondary" /></td>
                    <td className="px-4 py-4"><Skeleton className="h-8 w-24 bg-secondary ml-auto" /></td>
                  </tr>
                ))
              ) : missions?.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                    NO MISSIONS FOUND IN SYSTEM LOG
                  </td>
                </tr>
              ) : (
                missions?.map((mission) => {
                  const cost = mission.costUsd ?? 0;
                  const costStr =
                    cost >= 10 ? `$${cost.toFixed(2)}` : cost >= 1 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(4)}`;
                  return (
                  <tr key={mission.id} className="border-b border-border/50 hover:bg-secondary/30 transition-colors group">
                    <td className="px-4 py-4 text-primary">MSN-{mission.id.toString().padStart(3, '0')}</td>
                    <td className="px-4 py-4 font-sans text-foreground max-w-md truncate" title={mission.primeObjective}>
                      {mission.primeObjective}
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge status={mission.status} />
                    </td>
                    <td className="px-4 py-4 text-right">{mission.cycleCount}</td>
                    <td
                      className={`px-4 py-4 text-right tabular-nums ${cost > 0 ? "text-chart-2" : "text-muted-foreground"}`}
                      data-testid={`mission-cost-${mission.id}`}
                    >
                      {costStr}
                    </td>
                    <td className="px-4 py-4 text-muted-foreground text-xs">
                      {format(new Date(mission.updatedAt), "yyyy-MM-dd HH:mm")}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <Link 
                        href={`/missions/${mission.id}`} 
                        className="inline-flex items-center px-3 py-1 text-xs border border-primary/30 text-primary rounded-sm hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
                        data-testid={`link-mission-${mission.id}`}
                      >
                        <Target className="w-3 h-3 mr-1" />
                        MONITOR
                      </Link>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

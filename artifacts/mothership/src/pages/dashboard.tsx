import { Layout } from "@/components/layout";
import { useGetAuditStats, useGetRecentAuditEntries } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";

export function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetAuditStats();
  const { data: recent, isLoading: recentLoading } = useGetRecentAuditEntries();

  return (
    <Layout>
      <div className="p-6 h-full overflow-y-auto">
        <header className="mb-8 border-b border-border pb-4">
          <h1 className="text-2xl font-mono font-bold text-primary tracking-widest uppercase">System Dashboard</h1>
          <p className="text-muted-foreground font-mono text-sm mt-2">MOTHERSHIP GOVERNANCE OVERSIGHT // CLASSIFIED</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <StatCard title="TOTAL MISSIONS" value={stats?.totalMissions} loading={statsLoading} testId="stat-total" />
          <StatCard title="ACTIVE MISSIONS" value={stats?.activeMissions} loading={statsLoading} highlight textClass="text-chart-4" testId="stat-active" />
          <StatCard title="VETO RATE" value={stats?.vetoRate ? `${(stats.vetoRate * 100).toFixed(1)}%` : "0%"} loading={statsLoading} textClass="text-destructive" testId="stat-veto" />
          <StatCard title="AVG ALIGNMENT" value={stats?.avgAlignmentScore?.toFixed(2) || "0.00"} loading={statsLoading} textClass="text-primary" testId="stat-align" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="bg-card border-border rounded-sm">
            <CardHeader className="border-b border-border py-3">
              <CardTitle className="font-mono text-sm tracking-widest text-primary flex items-center">
                <span className="w-2 h-2 bg-primary rounded-full mr-2 shadow-[0_0_8px_hsl(var(--primary))]"></span>
                RECENT PACKETS
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 max-h-[400px] overflow-y-auto">
              {recentLoading ? (
                <div className="p-4 space-y-4">
                  <Skeleton className="h-12 w-full bg-secondary" />
                  <Skeleton className="h-12 w-full bg-secondary" />
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {recent?.recentPackets.map((packet) => (
                    <div key={packet.id} className="p-4 hover:bg-secondary/50 transition-colors" data-testid={`packet-${packet.id}`}>
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-mono text-xs text-muted-foreground">MSN-{packet.missionId} // CYC-{packet.cycle}</span>
                        <span className={`font-mono text-xs px-2 py-0.5 rounded-sm border ${
                          packet.agentRole === 'worker' ? 'text-chart-4 border-chart-4/30' :
                          packet.agentRole === 'observer' ? 'text-chart-2 border-chart-2/30' :
                          'text-chart-5 border-chart-5/30'
                        }`}>
                          {packet.agentRole.toUpperCase()}
                        </span>
                      </div>
                      <p className="font-mono text-sm truncate text-foreground">{packet.reasoning}</p>
                    </div>
                  ))}
                  {recent?.recentPackets.length === 0 && (
                    <div className="p-8 text-center font-mono text-muted-foreground text-sm">NO RECENT PACKETS DETECTED</div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card border-border rounded-sm">
            <CardHeader className="border-b border-border py-3">
              <CardTitle className="font-mono text-sm tracking-widest text-destructive flex items-center">
                <span className="w-2 h-2 bg-destructive rounded-full mr-2 shadow-[0_0_8px_hsl(var(--destructive))] animate-pulse"></span>
                CRITICAL VETOES
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 max-h-[400px] overflow-y-auto">
              {recentLoading ? (
                <div className="p-4 space-y-4">
                  <Skeleton className="h-12 w-full bg-secondary" />
                  <Skeleton className="h-12 w-full bg-secondary" />
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {recent?.recentVetoes.map((veto) => (
                    <div key={veto.id} className="p-4 bg-destructive/5 hover:bg-destructive/10 transition-colors border-l-2 border-l-destructive" data-testid={`veto-${veto.id}`}>
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-mono text-xs text-muted-foreground">MSN-{veto.missionId} // CYC-{veto.cycle}</span>
                        <span className="font-mono text-xs text-destructive px-2 py-0.5 bg-destructive/20 rounded-sm">
                          BY {veto.vetoedBy.toUpperCase()}
                        </span>
                      </div>
                      <p className="font-mono text-sm text-foreground mb-1 line-clamp-2">{veto.reason}</p>
                      <p className="font-mono text-xs text-muted-foreground truncate opacity-70">PROP: {veto.proposalSummary}</p>
                    </div>
                  ))}
                  {recent?.recentVetoes.length === 0 && (
                    <div className="p-8 text-center font-mono text-muted-foreground text-sm">NO RECENT VETOES</div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}

function StatCard({ title, value, loading, highlight, textClass = "text-foreground", testId }: { title: string; value: any; loading: boolean; highlight?: boolean; textClass?: string; testId?: string }) {
  return (
    <Card className={`rounded-sm border-border ${highlight ? 'bg-secondary/50 border-chart-4/30 shadow-[inset_0_0_20px_hsl(var(--chart-4)/0.05)]' : 'bg-card'}`}>
      <CardContent className="p-4">
        <p className="font-mono text-xs text-muted-foreground mb-2">{title}</p>
        {loading ? (
          <Skeleton className="h-8 w-24 bg-secondary" />
        ) : (
          <p data-testid={testId} className={`font-mono text-2xl font-bold tracking-wider ${textClass}`}>
            {value !== undefined ? value : "---"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

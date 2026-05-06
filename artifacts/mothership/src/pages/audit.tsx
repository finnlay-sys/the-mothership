import { Layout } from "@/components/layout";
import { useGetAuditStats, useGetRecentAuditEntries, useListRules } from "@workspace/api-client-react";
import { format } from "date-fns";

export function Audit() {
  const { data: recent, isLoading: recentLoading } = useGetRecentAuditEntries();
  const { data: stats } = useGetAuditStats();

  return (
    <Layout>
      <div className="p-6 h-full flex flex-col">
        <header className="mb-6 border-b border-border pb-4 shrink-0">
          <h1 className="text-2xl font-mono font-bold text-primary tracking-widest uppercase">Audit Trail</h1>
          <p className="text-muted-foreground font-mono text-sm mt-2">IMMUTABLE REASONING LOG</p>
        </header>

        <div className="flex-1 overflow-auto bg-card border border-border rounded-sm relative">
          <div className="absolute top-0 right-0 p-4 font-mono text-xs text-muted-foreground flex gap-4 bg-background/80 backdrop-blur-sm border-b border-l border-border rounded-bl-sm">
            <span>PACKETS: {stats?.totalPackets || 0}</span>
            <span className="text-destructive">VETOES: {stats?.totalVetoes || 0}</span>
          </div>

          <div className="p-6 space-y-6 pt-16">
            {recentLoading ? (
              <div className="text-center font-mono text-muted-foreground py-10 animate-pulse">DECRYPTING LOGS...</div>
            ) : recent?.recentPackets.length === 0 ? (
              <div className="text-center font-mono text-muted-foreground py-10">NO LOGS AVAILABLE</div>
            ) : (
              recent?.recentPackets.map((packet) => (
                <div key={packet.id} className="border-l-2 pl-4 py-1" style={{ borderColor: packet.agentRole === 'worker' ? 'hsl(var(--chart-4))' : packet.agentRole === 'observer' ? 'hsl(var(--chart-2))' : 'hsl(var(--chart-5))' }}>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="font-mono text-xs px-2 py-0.5 bg-secondary rounded-sm text-foreground">
                      {format(new Date(packet.createdAt), "yyyy-MM-dd HH:mm:ss")}
                    </span>
                    <span className={`font-mono text-xs font-bold tracking-widest ${
                      packet.agentRole === 'worker' ? 'text-chart-4' :
                      packet.agentRole === 'observer' ? 'text-chart-2' : 'text-chart-5'
                    }`}>
                      [{packet.agentRole.toUpperCase()}]
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">MSN-{packet.missionId} // CYC-{packet.cycle}</span>
                  </div>
                  <div className="font-mono text-sm whitespace-pre-wrap text-foreground/90">
                    {packet.reasoning}
                  </div>
                  {packet.proposal && (
                    <div className="mt-2 p-3 bg-secondary/30 rounded-sm border border-border font-mono text-xs text-muted-foreground">
                      <span className="text-foreground">PROPOSAL:</span> {packet.proposal}
                    </div>
                  )}
                  {packet.verdict && (
                    <div className="mt-2 font-mono text-xs font-bold">
                      VERDICT: <span className={packet.verdict === 'PASS' ? 'text-chart-2' : 'text-destructive'}>{packet.verdict}</span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}

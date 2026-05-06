import { Link, useLocation } from "wouter";
import { Activity, ShieldAlert, FileText, Settings, Shield, LineChart, Zap, Database } from "lucide-react";
import { useHealthCheck } from "@workspace/api-client-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: health } = useHealthCheck();

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex crt-effect selection:bg-primary selection:text-primary-foreground">
      <aside className="w-64 border-r border-border bg-sidebar flex flex-col shrink-0">
        <div className="h-16 flex items-center px-6 border-b border-border">
          <Shield className="w-6 h-6 text-primary mr-3" />
          <span className="font-mono font-bold tracking-widest text-primary text-sm">MOTHERSHIP.OS</span>
        </div>
        
        <nav className="flex-1 p-4 space-y-2">
          <NavItem href="/" icon={Activity} label="SYS.DASHBOARD" active={location === "/"} />
          <NavItem href="/missions" icon={ShieldAlert} label="MISSIONS.LOG" active={location.startsWith("/missions")} />
          <NavItem href="/market" icon={LineChart} label="MARKET.FEED" active={location === "/market"} />
          <NavItem href="/audit" icon={FileText} label="AUDIT.TRAIL" active={location === "/audit"} />
          <NavItem href="/execution" icon={Zap} label="EXECUTION" active={location === "/execution"} />
          <NavItem href="/ledger" icon={Database} label="LEDGER.CHAIN" active={location === "/ledger"} />
          <NavItem href="/rules" icon={Settings} label="GOV.RULES" active={location === "/rules"} />
        </nav>

        <div className="p-4 border-t border-border bg-sidebar-accent">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-muted-foreground">NODE.STATUS</span>
            <div className="flex items-center space-x-2">
              <span className={`w-2 h-2 rounded-full ${health?.status === "ok" ? "bg-primary animate-pulse shadow-[0_0_8px_hsl(var(--primary))]" : "bg-destructive"}`} />
              <span className={health?.status === "ok" ? "text-primary" : "text-destructive"}>{health?.status === "ok" ? "ONLINE" : "OFFLINE"}</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {children}
      </main>
    </div>
  );
}

function NavItem({ href, icon: Icon, label, active }: { href: string; icon: any; label: string; active: boolean }) {
  return (
    <Link href={href}>
      <div 
        data-testid={`nav-${label.toLowerCase()}`}
        className={`flex items-center px-3 py-2 rounded-sm cursor-pointer font-mono text-sm transition-all duration-200 ${
          active 
            ? "bg-primary/10 text-primary border border-primary/50 shadow-[inset_0_0_12px_hsl(var(--primary)/0.2)]" 
            : "text-muted-foreground hover:text-foreground hover:bg-secondary border border-transparent"
        }`}
      >
        <Icon className={`w-4 h-4 mr-3 ${active ? "animate-pulse" : ""}`} />
        {label}
      </div>
    </Link>
  );
}

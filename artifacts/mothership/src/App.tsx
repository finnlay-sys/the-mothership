import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

// Pages
import { Dashboard } from "@/pages/dashboard";
import { Missions } from "@/pages/missions";
import { NewMission } from "@/pages/new-mission";
import { MissionDetail } from "@/pages/mission-detail";
import { Audit } from "@/pages/audit";
import { Rules } from "@/pages/rules";
import { Market } from "@/pages/market";
import { Execution } from "@/pages/execution";
import { Ledger } from "@/pages/ledger";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/missions" component={Missions} />
      <Route path="/missions/new" component={NewMission} />
      <Route path="/missions/:id" component={MissionDetail} />
      <Route path="/market" component={Market} />
      <Route path="/audit" component={Audit} />
      <Route path="/execution" component={Execution} />
      <Route path="/ledger" component={Ledger} />
      <Route path="/rules" component={Rules} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

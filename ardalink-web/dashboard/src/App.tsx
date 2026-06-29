import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import CallReceiver from "@/pages/call-receiver";
import { AuthGate, type SessionInfo } from "@/components/AuthGate";

const queryClient = new QueryClient();

function Router() {
  return (
    <AuthGate>
      {(session: SessionInfo) => (
        <Switch>
          <Route path="/" component={() => <Dashboard session={session} />} />
          <Route path="/call" component={CallReceiver} />
          <Route path="/call/:token" component={CallReceiver} />
          <Route component={NotFound} />
        </Switch>
      )}
    </AuthGate>
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

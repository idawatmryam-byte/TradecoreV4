import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toast';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Layout } from '@/components/layout';
import { AuthGate } from '@/components/auth-gate';
import { Dashboard } from '@/pages/dashboard';
import { Trades } from '@/pages/trades';
import { Stats } from '@/pages/stats';
import { Memory } from '@/pages/memory';
import { Settings } from '@/pages/settings';
import { Backtest } from '@/pages/backtest';
import { Strategies } from '@/pages/strategies';

const queryClient = new QueryClient();

function NotFound() {
  return (
    <div className="min-h-[50vh] flex flex-col items-center justify-center text-center">
      <h1 className="text-4xl font-mono font-bold text-primary mb-2">404</h1>
      <p className="text-muted-foreground uppercase tracking-widest font-mono text-sm">Sector not found.</p>
    </div>
  );
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/trades" component={Trades} />
        <Route path="/stats" component={Stats} />
        <Route path="/memory" component={Memory} />
        <Route path="/backtest" component={Backtest} />
        <Route path="/strategies" component={Strategies} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <AuthGate>
          <Router />
          <Toaster />
        </AuthGate>
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;

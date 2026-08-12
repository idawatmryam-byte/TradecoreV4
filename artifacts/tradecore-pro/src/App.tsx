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
import { AiBrain } from '@/pages/ai-brain';
import { PortfolioIntelligence } from '@/pages/portfolio-intelligence';
import { StrategyBuilder } from '@/pages/strategy-builder';
import { Account } from '@/pages/account';
import { Decisions } from '@/pages/decisions';
import { Journal } from '@/pages/journal';
import CoPilot from '@/pages/copilot';
import CoPilotWorkspace from '@/pages/copilot-workspace';
import { BrainControlCenter } from '@/pages/brain-control-center';
import { SectionProvider } from '@/lib/section';
import { OnboardingWizard } from '@/components/onboarding-wizard';
import { hasOnboarded, markOnboarded } from '@/lib/onboarding';
import { useState } from 'react';

const queryClient = new QueryClient();

function NotFound() {
  return (
    <div className="min-h-[50vh] flex flex-col items-center justify-center text-center">
      <h1 className="text-4xl font-mono font-bold text-primary mb-2">404</h1>
      <p className="text-muted-foreground text-sm">Sector not found.</p>
    </div>
  );
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/portfolio" component={PortfolioIntelligence} />
        <Route path="/trades" component={Trades} />
        <Route path="/ai-brain" component={AiBrain} />
        <Route path="/copilot" component={CoPilot} />
        <Route path="/copilot/:id" component={CoPilotWorkspace} />
        <Route path="/autopilot" component={BrainControlCenter} />
        <Route path="/decisions" component={Decisions} />
        <Route path="/journal" component={Journal} />
        <Route path="/stats" component={Stats} />
        <Route path="/memory" component={Memory} />
        <Route path="/backtest" component={Backtest} />
        <Route path="/strategies" component={Strategies} />
        <Route path="/builder" component={StrategyBuilder} />
        <Route path="/settings" component={Settings} />
        <Route path="/account" component={Account} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  // Shown once, to an account created in this session, in a browser that has
  // not already completed it. Both conditions matter: the first keeps existing
  // users out of it, the second keeps it from reappearing after a skip.
  const [showOnboarding, setShowOnboarding] = useState(false);

  return (
    <QueryClientProvider client={queryClient}>
      <SectionProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AuthGate onRegistered={() => { if (!hasOnboarded()) setShowOnboarding(true); }}>
            {showOnboarding
              ? <OnboardingWizard onDone={() => { markOnboarded(); setShowOnboarding(false); }} />
              : <Router />}
            <Toaster />
          </AuthGate>
        </WouterRouter>
      </SectionProvider>
    </QueryClientProvider>
  );
}

export default App;

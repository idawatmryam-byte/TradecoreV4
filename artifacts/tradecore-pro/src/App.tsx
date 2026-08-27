import { lazy, Suspense, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, Route, Router as WouterRouter, Switch, useLocation } from "wouter";
import { ThemeProvider } from "next-themes";
import { Loader2 } from "lucide-react";
import { Layout } from "@/components/layout";
import { AuthGate } from "@/components/auth-gate";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { Toaster } from "@/components/ui/toast";
import { SectionProvider } from "@/lib/section";
import { hasOnboarded, markOnboarded } from "@/lib/onboarding";

const TraderDashboard = lazy(() => import("@/pages/trader-dashboard").then((module) => ({ default: module.TraderDashboard })));
const StrategiesHub = lazy(() => import("@/pages/strategies-hub").then((module) => ({ default: module.StrategiesHub })));
const BacktestLab = lazy(() => import("@/pages/backtest-lab").then((module) => ({ default: module.BacktestLab })));
const SettingsHub = lazy(() => import("@/pages/settings-hub").then((module) => ({ default: module.SettingsHub })));
const PortfolioIntelligence = lazy(() => import("@/pages/portfolio-intelligence").then((module) => ({ default: module.PortfolioIntelligence })));
const Trades = lazy(() => import("@/pages/trades").then((module) => ({ default: module.Trades })));
const AiBrain = lazy(() => import("@/pages/ai-brain").then((module) => ({ default: module.AiBrain })));
const CoPilot = lazy(() => import("@/pages/copilot"));
const CoPilotWorkspace = lazy(() => import("@/pages/copilot-workspace"));
const BrainControlCenter = lazy(() => import("@/pages/brain-control-center").then((module) => ({ default: module.BrainControlCenter })));
const ExecutionHealthPage = lazy(() => import("@/pages/execution-health").then((module) => ({ default: module.ExecutionHealthPage })));
const RestrictedLivePage = lazy(() => import("@/pages/restricted-live").then((module) => ({ default: module.RestrictedLivePage })));
const Decisions = lazy(() => import("@/pages/decisions").then((module) => ({ default: module.Decisions })));
const Journal = lazy(() => import("@/pages/journal").then((module) => ({ default: module.Journal })));
const Stats = lazy(() => import("@/pages/stats").then((module) => ({ default: module.Stats })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
    mutations: { retry: false },
  },
});

function LoadingPage() {
  return <div className="grid min-h-[55vh] place-items-center" role="status"><span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading workspace</span></div>;
}

function RedirectAlias({ target, view }: { target: string; view?: string }) {
  const [, navigate] = useLocation();
  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    if (view) parameters.set("view", view);
    const search = parameters.toString();
    navigate(`${target}${search ? `?${search}` : ""}`, { replace: true });
  }, [navigate, target, view]);
  return <LoadingPage />;
}

function NotFound() {
  return (
    <div className="grid min-h-[55vh] place-items-center text-center">
      <div><p className="font-mono text-sm font-semibold text-primary">404</p><h1 className="mt-2 text-2xl font-semibold">Workspace not found</h1><p className="mt-2 text-sm text-muted-foreground">This route is not part of the Cactus AI trader workspace.</p><Link href="/dashboard" className="mt-5 inline-flex min-h-10 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground">Return to Dashboard</Link></div>
    </div>
  );
}

function AppRoutes() {
  return (
    <Layout>
      <Suspense fallback={<LoadingPage />}>
        <Switch>
          <Route path="/" component={() => <RedirectAlias target="/dashboard" />} />
          <Route path="/dashboard/recommendations/:id" component={CoPilotWorkspace} />
          <Route path="/dashboard" component={TraderDashboard} />
          <Route path="/strategies" component={StrategiesHub} />
          <Route path="/backtest" component={BacktestLab} />
          <Route path="/settings" component={SettingsHub} />

          <Route path="/builder" component={() => <RedirectAlias target="/strategies" view="builder" />} />
          <Route path="/memory" component={() => <RedirectAlias target="/strategies" view="evidence" />} />
          <Route path="/account" component={() => <RedirectAlias target="/settings" view="profile" />} />

          <Route path="/portfolio" component={PortfolioIntelligence} />
          <Route path="/trades" component={Trades} />
          <Route path="/ai-brain" component={AiBrain} />
          <Route path="/copilot" component={CoPilot} />
          <Route path="/copilot/:id" component={CoPilotWorkspace} />
          <Route path="/autopilot" component={BrainControlCenter} />
          <Route path="/execution-health" component={ExecutionHealthPage} />
          <Route path="/restricted-live" component={RestrictedLivePage} />
          <Route path="/decisions" component={Decisions} />
          <Route path="/journal" component={Journal} />
          <Route path="/stats" component={Stats} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  const [showOnboarding, setShowOnboarding] = useState(false);
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <SectionProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AuthGate onRegistered={() => { if (!hasOnboarded()) setShowOnboarding(true); }}>
              {showOnboarding
                ? <OnboardingWizard onDone={() => { markOnboarded(); setShowOnboarding(false); }} />
                : <AppRoutes />}
              <Toaster />
            </AuthGate>
          </WouterRouter>
        </SectionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

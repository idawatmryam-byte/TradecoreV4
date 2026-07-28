import { useEffect, useState } from "react";
import {
  useGetConfig, useUpdateConfig, useStartBot,
  getGetConfigQueryKey, getGetBotStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity, Bitcoin, CandlestickChart, Check, ChevronLeft, Loader2,
  ShieldCheck, TrendingUp, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSection, type Section } from "@/lib/section";
import { ModePicker, MODE_LABELS, type TradingMode } from "@/components/mode-picker";
import { BrokerCredentialsCard, useBrokerConfigured } from "@/components/broker-credentials";
import { AutoPilotConfirmDialog } from "@/components/autopilot-confirm-dialog";

/**
 * First run: opening a trading account, not configuring software.
 *
 * Three questions, in the order a person actually decides them — paper or real
 * money, which market, who authorises a trade — and then the account exists.
 * Demo is created and started for you and lands on a confirmation; Live asks
 * for the broker credentials it genuinely needs, verifies them, and then waits
 * for a deliberate press of Start. Nothing here is permanent: every one of the
 * three is a Settings control the day after.
 *
 * Deliberately ONE market. The engine runs a single section at a time (see
 * `bot.ts` — starting one stops the other), so offering both here would be
 * offering something the backend cannot do. The second market is added later
 * from Settings, which is also how this component gets reused: pass
 * `presetMarket` and the market question is skipped.
 */

const MARKETS: { id: Section; label: string; icon: typeof Bitcoin; blurb: string }[] = [
  { id: "crypto", label: "Crypto", icon: Bitcoin, blurb: "Bitcoin, Ethereum and major altcoins on Binance — trades around the clock." },
  { id: "forex", label: "Forex", icon: CandlestickChart, blurb: "Currency majors, gold and US indices on OANDA — follows real market hours." },
];

const MARKET_LABELS: Record<Section, string> = { crypto: "Crypto", forex: "Forex" };

type StepId = "target" | "market" | "mode" | "finish";

export function OnboardingWizard({
  onDone,
  presetMarket,
}: {
  /**
   * Called when the user finishes or skips. `completed` is true only when this
   * market was actually configured — callers that switched the active section
   * to run this wizard need it to know whether to switch back, since backing
   * out must not strand the user in a market they declined to set up.
   */
  onDone: (completed: boolean) => void;
  /** Skips the market question — used by Settings → Add Market. */
  presetMarket?: Section;
}) {
  const { section, setSection } = useSection();
  const queryClient = useQueryClient();
  const { data: config } = useGetConfig({ query: { queryKey: getGetConfigQueryKey() } });
  const updateConfig = useUpdateConfig();
  const startBot = useStartBot();

  const steps: StepId[] = presetMarket
    ? ["target", "mode", "finish"]
    : ["target", "market", "mode", "finish"];

  const [stepIndex, setStepIndex] = useState(0);
  const [target, setTarget] = useState<"demo" | "live">("demo");
  const [market, setMarket] = useState<Section>(presetMarket ?? section);
  const [mode, setMode] = useState<TradingMode>("copilot");

  // Everything the wizard writes is section-scoped through the X-Section
  // header, so the chosen market must BE the active section before any config
  // write lands — otherwise it silently configures the other one.
  useEffect(() => {
    if (section !== market) setSection(market);
  }, [market, section, setSection]);

  const step = steps[stepIndex];
  const next = () => setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  const back = () => setStepIndex((i) => Math.max(i - 1, 0));

  // Forex demo needs the platform's own OANDA practice token — OANDA publishes
  // no public market data, so a keyless forex demo is impossible rather than
  // merely unconfigured. Promising "no broker needed" and then refusing to
  // start would be the worst of both worlds.
  const demoBlocked = target === "demo" && config?.demoDataAvailable === false;

  return (
    <div className="relative min-h-[100dvh] overflow-hidden bg-background">
      <div className="ambient-glow" />
      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col px-5 py-8 sm:py-12">
        <header className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-primary/40 bg-primary/15">
            <Activity className="h-5 w-5 text-primary" />
          </div>
          <span className="text-lg font-semibold leading-none tracking-tight">TradeCore Pro</span>
          <button
            type="button"
            onClick={() => onDone(false)}
            className="ml-auto text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip for now
          </button>
        </header>

        {/* Step rail. `finish` is the outcome, not a question, so it is not a dot. */}
        <div className="mt-8 flex items-center gap-2">
          {steps.slice(0, -1).map((s, i) => (
            <div
              key={s}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors",
                i <= stepIndex ? "bg-primary" : "bg-border",
              )}
            />
          ))}
        </div>

        <div className="mt-8 flex-1">
          {step === "target" && (
            <StepShell
              title="How would you like to start?"
              subtitle="Both run the same engine and the same analysis. The only difference is whether an order costs real money."
            >
              <div className="grid gap-3">
                <ChoiceCard
                  active={target === "demo"}
                  onClick={() => { setTarget("demo"); next(); }}
                  icon={ShieldCheck}
                  title="Demo Trading"
                  recommended
                  blurb="A simulated account traded against live market data. No broker, no API keys, no risk — and every feature of the platform."
                />
                <ChoiceCard
                  active={target === "live"}
                  onClick={() => { setTarget("live"); next(); }}
                  icon={TrendingUp}
                  title="Live Trading"
                  blurb="Real orders through your own broker account. You'll connect your API credentials in a moment."
                />
              </div>
            </StepShell>
          )}

          {step === "market" && (
            <StepShell
              title="Which market?"
              subtitle="Pick the one you know best. You can add the other from Settings whenever you want — the engine trades one at a time."
              onBack={back}
            >
              <div className="grid gap-3">
                {MARKETS.map((m) => (
                  <ChoiceCard
                    key={m.id}
                    active={market === m.id}
                    onClick={() => { setMarket(m.id); next(); }}
                    icon={m.icon}
                    title={m.label}
                    blurb={m.blurb}
                  />
                ))}
              </div>
            </StepShell>
          )}

          {step === "mode" && (
            <StepShell
              title="Who decides on a trade?"
              subtitle="The engine's analysis is identical in all three. This only changes who authorises an order — and you can change it any time in Settings."
              onBack={back}
            >
              {demoBlocked ? (
                <ForexDemoUnavailable
                  onUseCrypto={() => { setMarket("crypto"); }}
                  onUseLive={() => setTarget("live")}
                />
              ) : (
                <>
                  <ModePicker value={mode} onChange={setMode} showRecommended />
                  <Button className="mt-6 w-full" size="lg" onClick={next}>
                    Continue
                  </Button>
                </>
              )}
            </StepShell>
          )}

          {step === "finish" && (
            target === "demo" ? (
              <DemoFinish
                market={market}
                mode={mode}
                onBack={back}
                onDone={onDone}
                apply={async () => {
                  await updateConfig.mutateAsync({ data: { executionTarget: "demo", mode } });
                  queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() });
                  await startBot.mutateAsync(undefined);
                  queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
                }}
              />
            ) : (
              <LiveFinish
                market={market}
                mode={mode}
                onBack={back}
                onDone={onDone}
                applyLive={async (finalMode) => {
                  await updateConfig.mutateAsync({ data: { executionTarget: "live", mode: finalMode } });
                  queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() });
                }}
                start={async () => {
                  await startBot.mutateAsync(undefined);
                  queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
                }}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Shared step chrome ─────────────────────────────────────────────────── */

function StepShell({
  title, subtitle, children, onBack,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  onBack?: () => void;
}) {
  return (
    <div>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-4 -ml-1 flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> Back
        </button>
      )}
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function ChoiceCard({
  active, onClick, icon: Icon, title, blurb, recommended,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Bitcoin;
  title: string;
  blurb: string;
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex gap-4 rounded-lg border p-4 text-left transition-colors",
        active ? "border-primary bg-primary/10" : "border-border hover:bg-muted/50",
      )}
    >
      <div className={cn(
        "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border",
        active ? "border-primary/40 bg-primary/15" : "border-border bg-muted/40",
      )}>
        <Icon className={cn("h-4 w-4", active ? "text-primary" : "text-muted-foreground")} />
      </div>
      <div>
        <span className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {recommended && (
            <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
              Recommended
            </span>
          )}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{blurb}</span>
      </div>
    </button>
  );
}

/**
 * Said plainly instead of offering a Start that will be refused. Deliberately
 * does not name the environment variables involved — they are set by whoever
 * runs the deployment, not by the person reading this.
 */
function ForexDemoUnavailable({ onUseCrypto, onUseLive }: { onUseCrypto: () => void; onUseLive: () => void }) {
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-warning">
        <AlertTriangle className="h-4 w-4" /> Forex demo isn't available here
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Simulated forex needs a market-data source this deployment doesn't have.
        Crypto needs no credentials and works right now — or connect your own
        OANDA account and trade this section live.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={onUseCrypto}>Use Crypto Demo instead</Button>
        <Button size="sm" variant="outline" onClick={onUseLive}>Connect OANDA and go live</Button>
      </div>
    </div>
  );
}

/* ── Demo: create it, start it, confirm it ──────────────────────────────── */

function DemoFinish({
  market, mode, apply, onBack, onDone,
}: {
  market: Section;
  mode: TradingMode;
  apply: () => Promise<void>;
  onBack: () => void;
  onDone: (completed: boolean) => void;
}) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state !== "idle") return;
    setState("working");
    apply()
      .then(() => setState("done"))
      .catch((err: unknown) => {
        const body = (err as { response?: { data?: { error?: string } } })?.response?.data;
        setError(body?.error ?? (err as Error)?.message ?? "The server refused the request.");
        setState("error");
      });
    // Runs once on arrival: this step IS the action, not a form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (state === "working" || state === "idle") {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="mt-4 text-sm text-muted-foreground">Setting up your {MARKET_LABELS[market]} Demo account…</p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <StepShell
        title="That didn't go through"
        subtitle="Your account is fine — the demo just couldn't be started. You can go to the dashboard and press Start yourself, or go back and pick a different market."
        onBack={onBack}
      >
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
        <Button className="mt-6 w-full" size="lg" onClick={() => setState("idle")}>Try again</Button>
        <button
          type="button"
          onClick={() => onDone(false)}
          className="mt-3 w-full text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Go to the dashboard instead
        </button>
      </StepShell>
    );
  }

  return (
    <div>
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15">
        <Check className="h-6 w-6 text-success" />
      </div>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">Welcome to TradeCore.</h1>
      <p className="mt-2 text-sm text-muted-foreground">Your Demo account is ready.</p>

      <ul className="mt-6 space-y-2.5">
        <ReadyRow label={`${MARKET_LABELS[market]} Demo`} />
        <ReadyRow label={MODE_LABELS[mode]} />
      </ul>

      <p className="mt-6 text-sm text-muted-foreground">The engine is now watching the market.</p>

      <Button className="mt-8 w-full" size="lg" onClick={() => onDone(true)}>Go to Dashboard</Button>
    </div>
  );
}

function ReadyRow({ label }: { label: string }) {
  return (
    <li className="flex items-center gap-2.5 text-sm">
      <Check className="h-4 w-4 shrink-0 text-success" />
      <span className="font-medium">{label}</span>
    </li>
  );
}

/* ── Live: verify credentials, then wait to be told to start ────────────── */

function LiveFinish({
  market, mode, applyLive, start, onBack, onDone,
}: {
  market: Section;
  mode: TradingMode;
  applyLive: (finalMode: TradingMode) => Promise<void>;
  start: () => Promise<void>;
  onBack: () => void;
  onDone: (completed: boolean) => void;
}) {
  const { configured } = useBrokerConfigured(market);
  const [phase, setPhase] = useState<"credentials" | "enabling" | "ready" | "starting">("credentials");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [finalMode, setFinalMode] = useState<TradingMode>(mode);
  const [error, setError] = useState<string | null>(null);

  const enable = async (chosen: TradingMode) => {
    setFinalMode(chosen);
    setPhase("enabling");
    setError(null);
    try {
      await applyLive(chosen);
      setPhase("ready");
    } catch (err: unknown) {
      const body = (err as { response?: { data?: { error?: string } } })?.response?.data;
      setError(body?.error ?? (err as Error)?.message ?? "The server refused the request.");
      setPhase("credentials");
    }
  };

  const handleContinue = () => {
    // The only branch that needs a conscious extra confirmation: live money,
    // executed with no per-trade approval.
    if (mode === "autopilot") setConfirmOpen(true);
    else void enable(mode);
  };

  const handleStart = async () => {
    setPhase("starting");
    setError(null);
    try {
      await start();
      onDone(true);
    } catch (err: unknown) {
      const body = (err as { response?: { data?: { error?: string } } })?.response?.data;
      setError(body?.error ?? (err as Error)?.message ?? "The engine refused to start.");
      setPhase("ready");
    }
  };

  if (phase === "ready" || phase === "starting") {
    return (
      <div>
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15">
          <Check className="h-6 w-6 text-success" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">
          {MARKET_LABELS[market]} Live is ready.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your broker is connected and this section is set to trade with real funds.
          Nothing happens until you start the engine.
        </p>

        <ul className="mt-6 space-y-2.5">
          <ReadyRow label={`${MARKET_LABELS[market]} Live`} />
          <ReadyRow label={MODE_LABELS[finalMode]} />
        </ul>

        {error && (
          <p className="mt-6 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <Button className="mt-8 w-full" size="lg" onClick={handleStart} disabled={phase === "starting"}>
          {phase === "starting" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Start Trading"}
        </Button>
        <button
          type="button"
          onClick={() => onDone(true)}
          className="mt-3 w-full text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          I'll start it later
        </button>
      </div>
    );
  }

  return (
    <StepShell
      title="Connect your broker"
      subtitle={market === "forex"
        ? "Live forex trades run through your own OANDA account. Your token is encrypted and never shown back to you."
        : "Live crypto trades run through your own Binance account. Your keys are encrypted and never shown back to you."}
      onBack={onBack}
    >
      <BrokerCredentialsCard section={market} />

      {error && (
        <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <Button
        className="mt-6 w-full"
        size="lg"
        onClick={handleContinue}
        disabled={!configured || phase === "enabling"}
      >
        {phase === "enabling"
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : configured ? "Continue" : "Save your credentials to continue"}
      </Button>

      <AutoPilotConfirmDialog
        open={confirmOpen}
        marketLabel={MARKET_LABELS[market]}
        onSwitchToCopilot={() => { setConfirmOpen(false); void enable("copilot"); }}
        onContinueWithAutoPilot={() => { setConfirmOpen(false); void enable("autopilot"); }}
      />
    </StepShell>
  );
}

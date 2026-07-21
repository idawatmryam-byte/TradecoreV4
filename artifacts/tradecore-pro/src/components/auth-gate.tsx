import { useEffect, useState } from "react";
import {
  ShieldCheck, Loader2, User, KeyRound, Bot, FlaskConical, BrainCircuit,
  Wallet, LineChart, CheckCircle2, PlayCircle,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

/**
 * Multi-user Phase.
 *
 * The API requires a session cookie on every route except /healthz and
 * /auth/*. This gate checks auth state once on load; if unauthenticated it
 * renders the full login experience: a product pitch panel plus the auth
 * card (username/password and — when the server has them configured — Google
 * and Apple sign-in, discovered via GET /auth/providers).
 */

const FEATURES = [
  {
    icon: Bot,
    title: "Autonomous multi-strategy engine",
    text: "Seven configurable strategies scan 24 markets around the clock — regime detection decides which strategy hunts when.",
  },
  {
    icon: Wallet,
    title: "Risk in dollars, not jargon",
    text: "Tell it the exact dollars you're willing to lose and aiming to win — position size, stop and target prices are derived automatically.",
  },
  {
    icon: FlaskConical,
    title: "Backtests you can trust",
    text: "The backtester runs the same code as live trading — same signals, same sizing, same fees — so results mean what they say.",
  },
  {
    icon: BrainCircuit,
    title: "A memory that learns",
    text: "Every closed trade is automatically analyzed and graded; the engine builds an evidence-based record of what works and what doesn't.",
  },
  {
    icon: ShieldCheck,
    title: "Your keys, your custody",
    text: "Trades run through your own Binance API keys, AES-256 encrypted at rest. Funds never leave your exchange account.",
  },
] as const;

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.16-3.16A10.96 10.96 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8.88-.18 1.72-.87 3.05-.78 1.6.13 2.8.76 3.59 1.9-3.31 1.98-2.53 6.34.79 7.66-.6 1.58-1.38 3.14-2.51 4.39zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
    </svg>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  // Visitors arriving from the landing page's "Launch the live app" button carry
  // ?signup=1 — they have no account yet, so open straight on Create account.
  const [mode, setMode] = useState<"login" | "register">(() =>
    new URLSearchParams(window.location.search).has("signup") ? "register" : "login",
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<{ google: boolean; apple: boolean }>({ google: false, apple: false });
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  // Landing-page deep link: /app/?demo=1 lands here wanting the demo launched
  // immediately (fired once the /auth/providers check confirms one exists).
  const [autoDemoWanted, setAutoDemoWanted] = useState(() =>
    new URLSearchParams(window.location.search).has("demo"),
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/status", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setStatus(data?.authenticated ? "authenticated" : "unauthenticated");
      })
      .catch(() => { if (!cancelled) setStatus("unauthenticated"); });
    fetch("/api/auth/providers", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data) return;
        setProviders({ google: !!data.google, apple: !!data.apple });
        setDemoAvailable(!!data.demo);
      })
      .catch(() => {});
    // Surface a failed OAuth redirect (e.g. cancelled at Google) as a message.
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth_error")) {
      setError("Social sign-in didn't complete. Try again, or log in with username and password.");
    }
    // Clean one-shot query flags (signup, auth_error, demo) out of the address bar.
    if (params.has("auth_error") || params.has("signup") || params.has("demo")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    return () => { cancelled = true; };
  }, []);

  // Auto-launch the demo when arriving via /app/?demo=1, once we've confirmed a
  // demo account exists. Fires at most once.
  useEffect(() => {
    if (autoDemoWanted && demoAvailable && status === "unauthenticated" && !demoLoading) {
      setAutoDemoWanted(false);
      void handleDemo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDemoWanted, demoAvailable, status]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        setStatus("authenticated");
        return;
      }
      if (res.status === 429) {
        setError("Too many attempts. Wait a few minutes and try again.");
        return;
      }
      const data = await res.json().catch(() => null);
      if (mode === "register" && res.status === 409) {
        setError("Username already taken.");
      } else if (mode === "register" && res.status === 400) {
        setError(data?.error ?? "Invalid username or password.");
      } else {
        setError("Invalid username or password.");
      }
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDemo() {
    setDemoLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/demo", { method: "POST", credentials: "same-origin" });
      if (res.ok) { setStatus("authenticated"); return; }
      setError("The demo isn't available right now. Create an account to get started.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setDemoLoading(false);
    }
  }

  if (status === "checking") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
      </div>
    );
  }

  if (status === "unauthenticated") {
    const anyOauth = providers.google || providers.apple;
    return (
      <div className="min-h-[100dvh] bg-background lg:grid lg:grid-cols-2">
        {/* ── Product pitch panel ─────────────────────────────────────────── */}
        <div className="relative hidden lg:flex flex-col justify-between overflow-hidden border-r border-border bg-gradient-to-br from-primary/10 via-background to-background p-10 xl:p-14">
          {/* faint grid backdrop */}
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.04]"
            style={{ backgroundImage: "linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)", backgroundSize: "44px 44px" }}
          />
          <div className="relative">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-lg bg-primary/20 border border-primary/50 flex items-center justify-center">
                <LineChart className="h-6 w-6 text-primary" />
              </div>
              <div>
                <div className="font-mono font-bold tracking-widest text-lg">TRADECORE PRO</div>
                <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Algorithmic Trading Platform</div>
              </div>
            </div>

            <h1 className="mt-12 text-3xl xl:text-4xl font-bold leading-tight max-w-md">
              Trade with a plan.<br />
              <span className="text-primary">Risk exactly what you choose.</span>
            </h1>
            <p className="mt-4 max-w-md text-sm text-muted-foreground leading-relaxed">
              TradeCore Pro is a self-hosted crypto trading engine for Binance spot and futures —
              built for people who want automation with full transparency: every signal, every
              risk check, and every exit is logged, explained, and graded.
            </p>

            <ul className="mt-10 space-y-5 max-w-md">
              {FEATURES.map((f) => (
                <li key={f.title} className="flex gap-3.5">
                  <div className="mt-0.5 h-8 w-8 shrink-0 rounded-md bg-primary/10 border border-primary/30 flex items-center justify-center">
                    <f.icon className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{f.title}</div>
                    <div className="text-xs text-muted-foreground leading-relaxed mt-0.5">{f.text}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <p className="relative mt-10 text-[11px] text-muted-foreground max-w-md leading-relaxed">
            Trading cryptocurrency involves substantial risk of loss. TradeCore Pro is software,
            not financial advice — no strategy is guaranteed profitable. Start on the built-in
            testnet with paper money.
          </p>
        </div>

        {/* ── Auth card ───────────────────────────────────────────────────── */}
        <div className="flex min-h-[100dvh] lg:min-h-0 items-center justify-center p-6">
          <div className="w-full max-w-sm">
            {/* compact brand header for mobile, where the pitch panel is hidden */}
            <div className="lg:hidden mb-8 text-center">
              <div className="mx-auto h-12 w-12 rounded-lg bg-primary/20 border border-primary/50 flex items-center justify-center">
                <LineChart className="h-6 w-6 text-primary" />
              </div>
              <div className="mt-3 font-mono font-bold tracking-widest text-lg">TRADECORE PRO</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Self-hosted algorithmic trading — dollar-based risk, honest backtests, full audit trail.
              </p>
            </div>

            <h2 className="text-xl font-bold">
              {mode === "login" ? "Welcome back" : "Create your account"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {mode === "login"
                ? "Log in to your trading cockpit."
                : "Your own engine, your own Binance keys — set up in minutes."}
            </p>

            {/* One-click demo — the fastest path to seeing the product work,
                no signup and no exchange keys. Read-only, clearly labeled. */}
            {demoAvailable && (
              <>
                <Button
                  type="button"
                  className="mt-6 w-full gap-2 font-semibold"
                  onClick={handleDemo}
                  disabled={demoLoading}
                >
                  {demoLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                  Explore the live demo — no signup
                </Button>
                <p className="mt-2 text-center text-[11px] text-muted-foreground">
                  A fully-loaded read-only account. See real trades, decisions, backtests and analytics instantly.
                </p>
                <div className="my-5 flex items-center gap-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">or sign in</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              </>
            )}

            {anyOauth && (
              <>
                <div className={demoAvailable ? "space-y-2.5" : "mt-6 space-y-2.5"}>
                  {providers.google && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full gap-2.5 font-medium"
                      onClick={() => { window.location.href = "/api/auth/google"; }}
                    >
                      <GoogleIcon /> Continue with Google
                    </Button>
                  )}
                  {providers.apple && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full gap-2.5 font-medium"
                      onClick={() => { window.location.href = "/api/auth/apple"; }}
                    >
                      <AppleIcon /> Continue with Apple
                    </Button>
                  )}
                </div>
                <div className="my-5 flex items-center gap-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">or</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              </>
            )}

            <form onSubmit={handleSubmit} className={anyOauth ? "space-y-4" : "mt-6 space-y-4"}>
              <div className="space-y-2">
                <Label htmlFor="auth-username">Username</Label>
                <div className="relative">
                  <User className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="auth-username"
                    type="text"
                    autoFocus
                    autoComplete="username"
                    className="pl-9"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Username"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="auth-password">Password</Label>
                <div className="relative">
                  <KeyRound className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="auth-password"
                    type="password"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    className="pl-9"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === "login" ? "Password" : "Password (min. 12 characters)"}
                  />
                </div>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={submitting || !username || !password}>
                {submitting
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : mode === "login" ? "Log In" : "Create Account"}
              </Button>
              <button
                type="button"
                className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}
              >
                {mode === "login" ? "New to TradeCore? Create an account" : "Already have an account? Log in"}
              </button>
            </form>

            {mode === "register" && (
              <ul className="mt-6 space-y-1.5">
                {["Free to run — self-hosted on your own server", "Paper-trade on testnet before risking a cent", "Your Binance API keys stay encrypted on YOUR machine"].map((t) => (
                  <li key={t} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" /> {t}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

import { useEffect, useState } from "react";
import {
  ShieldCheck,
  Loader2,
  User,
  KeyRound,
  FlaskConical,
  BrainCircuit,
  CheckCircle2,
  PlayCircle,
  Eye,
  EyeOff,
  ArrowRight,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  markOAuthSignupIntent,
  consumeOAuthSignupIntent,
} from "@/lib/onboarding";
import { CactusLogo } from "@/components/cactus-logo";

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
    icon: ShieldCheck,
    title: "Bounded before it acts",
    text: "Risk, exposure, stops, and exchange constraints are checked before execution.",
  },
  {
    icon: FlaskConical,
    title: "Research tied to reality",
    text: "Backtests reuse live strategy logic and account for the costs that change outcomes.",
  },
  {
    icon: BrainCircuit,
    title: "A decision trail you can inspect",
    text: "Signals, controls, approvals, and outcomes remain visible and auditable.",
  },
] as const;

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.16-3.16A10.96 10.96 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8.88-.18 1.72-.87 3.05-.78 1.6.13 2.8.76 3.59 1.9-3.31 1.98-2.53 6.34.79 7.66-.6 1.58-1.38 3.14-2.51 4.39zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

export function AuthGate({
  children,
  onRegistered,
}: {
  children: React.ReactNode;
  /**
   * Fired only when this session just CREATED an account — the signal the
   * onboarding wizard gates on. Logging in never fires it, so an existing user
   * is never walked back through first-run setup.
   *
   * Social sign-up fires it too, via the intent marker parked before the
   * redirect (see `lib/onboarding.ts`) — the OAuth callback itself carries no
   * way to tell a new account from a returning one.
   */
  onRegistered?: () => void;
}) {
  const [status, setStatus] = useState<
    "checking" | "authenticated" | "unauthenticated"
  >("checking");
  // Visitors arriving from the landing page's "Launch the live app" button carry
  // ?signup=1 — they have no account yet, so open straight on Create account.
  const [mode, setMode] = useState<"login" | "register">(() =>
    new URLSearchParams(window.location.search).has("signup")
      ? "register"
      : "login",
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<{
    google: boolean;
    apple: boolean;
  }>({ google: false, apple: false });
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  // Landing-page deep link: /app/?demo=1 lands here wanting the demo launched
  // immediately (fired once the /auth/providers check confirms one exists).
  const [autoDemoWanted, setAutoDemoWanted] = useState(() =>
    new URLSearchParams(window.location.search).has("demo"),
  );

  useEffect(() => {
    let cancelled = false;
    // Consumed unconditionally, acted on only when the round trip actually
    // produced a session: a cancelled or failed OAuth attempt must not leave
    // the marker armed to fire on an unrelated login later.
    const cameFromSocialSignup = consumeOAuthSignupIntent();
    fetch("/api/auth/status", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const authenticated = !!data?.authenticated;
        if (authenticated && cameFromSocialSignup) onRegistered?.();
        setStatus(authenticated ? "authenticated" : "unauthenticated");
      })
      .catch(() => {
        if (!cancelled) setStatus("unauthenticated");
      });
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
      setError(
        "Social sign-in didn't complete. Try again, or log in with username and password.",
      );
    }
    // Clean one-shot query flags (signup, auth_error, demo) out of the address bar.
    if (
      params.has("auth_error") ||
      params.has("signup") ||
      params.has("demo")
    ) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-launch the demo when arriving via /app/?demo=1, once we've confirmed a
  // demo account exists. Fires at most once.
  useEffect(() => {
    if (
      autoDemoWanted &&
      demoAvailable &&
      status === "unauthenticated" &&
      !demoLoading
    ) {
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
      const res = await fetch(
        mode === "login" ? "/api/auth/login" : "/api/auth/register",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        },
      );
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (mode === "register") onRegistered?.();
        if (mode === "login" && data?.destination === "/admin") {
          window.location.assign("/admin");
          return;
        }
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
      setError(
        "Couldn't reach the server. Check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Hand off to a social provider, remembering whether this was a sign-up.
   * The provider button is the same in both tabs, so the tab the user chose it
   * from is the only statement of intent that exists — and it disappears the
   * moment the page navigates away.
   */
  function startOauth(url: string) {
    if (mode === "register") markOAuthSignupIntent();
    window.location.href = url;
  }

  async function handleDemo() {
    setDemoLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/demo", {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.ok) {
        setStatus("authenticated");
        return;
      }
      setError(
        "The demo isn't available right now. Create an account to get started.",
      );
    } catch {
      setError(
        "Couldn't reach the server. Check your connection and try again.",
      );
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
      <div className="auth-shell min-h-[100dvh]">
        <header className="auth-topbar">
          <a href="/" aria-label="Cactus AI home">
            <CactusLogo size="lg" />
          </a>
          <a className="auth-back-link" href="/">
            Back to website <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </header>

        <main className="auth-layout">
          <section className="auth-story" aria-labelledby="auth-story-title">
            <div className="auth-story-copy">
              <div className="auth-kicker">
                <span /> Self-hosted trading control plane
              </div>
              <h1 id="auth-story-title">Your trading system, with receipts.</h1>
              <p className="auth-intro">
                Every signal, control, approval, and outcome stays visible—from
                market scan to post-trade review.
              </p>

              <ul className="auth-feature-list">
                {FEATURES.map((feature) => (
                  <li key={feature.title}>
                    <div className="auth-feature-icon">
                      <feature.icon className="h-4 w-4" />
                    </div>
                    <div>
                      <strong>{feature.title}</strong>
                      <span>{feature.text}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div
              className="auth-ledger"
              aria-label="Illustrative system control status"
            >
              <div className="auth-ledger-head">
                <span>Control status</span>
                <span className="auth-paper-badge">Paper mode</span>
              </div>
              <div className="auth-ledger-grid">
                <div>
                  <span>Execution</span>
                  <strong>Simulation only</strong>
                </div>
                <div>
                  <span>Risk policy</span>
                  <strong>Enforced</strong>
                </div>
                <div>
                  <span>Decision trail</span>
                  <strong>Recording</strong>
                </div>
              </div>
              <div className="auth-ledger-event">
                <span>
                  <b>risk.validate</b> → controls passed
                </span>
                <span>auditable</span>
              </div>
            </div>

            <p className="auth-risk-note">
              Trading carries substantial risk of loss. Cactus AI is software,
              not financial advice. Start with the read-only demo, then use
              simulation or testnet before risking funds.
            </p>
          </section>

          <section className="auth-form-pane" aria-labelledby="auth-heading">
            <div className="auth-card">
              <div
                className="auth-mode-switch"
                aria-label="Authentication mode"
              >
                <button
                  type="button"
                  aria-pressed={mode === "login"}
                  onClick={() => {
                    setMode("login");
                    setError(null);
                  }}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "register"}
                  onClick={() => {
                    setMode("register");
                    setError(null);
                  }}
                >
                  Create account
                </button>
              </div>

              <div className="auth-card-heading">
                <div className="auth-kicker">
                  <span /> Secure workspace access
                </div>
                <h2 id="auth-heading">
                  {mode === "login" ? "Welcome back" : "Create your account"}
                </h2>
                <p>
                  {mode === "login"
                    ? "Sign in to continue to your control plane."
                    : "Begin with simulation and configure your boundaries before connecting a broker."}
                </p>
              </div>

              {demoAvailable && (
                <div className="auth-demo">
                  <div>
                    <strong>Want to look around first?</strong>
                    <span>
                      Open a populated, read-only workspace. No signup or
                      credentials.
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="auth-demo-button"
                    onClick={handleDemo}
                    disabled={demoLoading}
                  >
                    {demoLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlayCircle className="h-4 w-4" />
                    )}
                    Explore demo
                  </Button>
                </div>
              )}

              {anyOauth && (
                <>
                  <div className="auth-socials">
                    {providers.google && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          startOauth("/api/auth/google");
                        }}
                      >
                        <GoogleIcon /> Continue with Google
                      </Button>
                    )}
                    {providers.apple && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          startOauth("/api/auth/apple");
                        }}
                      >
                        <AppleIcon /> Continue with Apple
                      </Button>
                    )}
                  </div>
                  <div className="auth-divider">
                    <span>or continue with username</span>
                  </div>
                </>
              )}

              <form
                onSubmit={handleSubmit}
                className={
                  anyOauth ? "auth-form" : "auth-form auth-form-spaced"
                }
              >
                <div className="auth-field">
                  <Label htmlFor="auth-username">Username</Label>
                  <div className="auth-input-wrap">
                    <User className="auth-input-icon" />
                    <Input
                      id="auth-username"
                      type="text"
                      autoFocus
                      autoComplete="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="Enter your username"
                    />
                  </div>
                </div>
                <div className="auth-field">
                  <Label htmlFor="auth-password">Password</Label>
                  <div className="auth-input-wrap">
                    <KeyRound className="auth-input-icon" />
                    <Input
                      id="auth-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete={
                        mode === "login" ? "current-password" : "new-password"
                      }
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={
                        mode === "login"
                          ? "Enter your password"
                          : "At least 12 characters"
                      }
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((value) => !value)}
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                      className="auth-password-toggle"
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                {error && (
                  <p className="auth-error" role="alert">
                    {error}
                  </p>
                )}

                <Button
                  type="submit"
                  className="auth-submit"
                  disabled={submitting || !username || !password}
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      {mode === "login" ? "Sign in" : "Create account"}
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </form>

              {mode === "register" && (
                <ul className="auth-register-notes">
                  {[
                    "Self-hosted on your own server",
                    "Demo and testnet before real funds",
                    "Broker credentials encrypted at rest",
                  ].map((text) => (
                    <li key={text}>
                      <CheckCircle2 className="h-3.5 w-3.5" /> {text}
                    </li>
                  ))}
                </ul>
              )}

              <p className="auth-switch-copy">
                {mode === "login"
                  ? "New to Cactus AI?"
                  : "Already have an account?"}
                <button
                  type="button"
                  onClick={() => {
                    setMode(mode === "login" ? "register" : "login");
                    setError(null);
                  }}
                >
                  {mode === "login" ? "Create an account" : "Sign in instead"}
                </button>
              </p>
            </div>
          </section>
        </main>
      </div>
    );
  }

  return <>{children}</>;
}

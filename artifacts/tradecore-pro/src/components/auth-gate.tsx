import { useEffect, useState } from "react";
import { ShieldCheck, Loader2, User, KeyRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

/**
 * Multi-user Phase.
 *
 * The API requires a session cookie or Basic-auth credentials on every
 * route except /healthz and /auth/*. This gate checks auth state once on
 * load; if unauthenticated, it blocks the whole app behind a login/register
 * prompt instead of letting every page underneath fire a wave of 401s. Each
 * user has their own account (registered here, or by an operator) and their
 * own Binance credentials (set later on the Settings page) — this form only
 * ever exchanges a username/password for the session cookie via
 * POST /auth/login or /auth/register; the browser handles the cookie
 * automatically from then on.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/status", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setStatus(data?.authenticated ? "authenticated" : "unauthenticated");
      })
      .catch(() => { if (!cancelled) setStatus("unauthenticated"); });
    return () => { cancelled = true; };
  }, []);

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

  if (status === "checking") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="space-y-3">
            <div className="h-10 w-10 rounded bg-primary/20 flex items-center justify-center border border-primary/50">
              <ShieldCheck className="h-5 w-5 text-primary" />
            </div>
            <CardTitle className="text-lg">TradeCore Pro</CardTitle>
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
              {mode === "login" ? "Log in to your account" : "Create your account"}
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
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
                {mode === "login" ? "Need an account? Register" : "Already have an account? Log in"}
              </button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}

import { useEffect, useState } from "react";
import { ShieldCheck, Loader2, KeyRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

/**
 * Phase 5B — Production Hardening.
 *
 * The API now requires a session cookie or bearer token on every route
 * except /healthz and /auth/*. This gate checks auth status once on load;
 * if unauthenticated, it blocks the whole app behind a token prompt instead
 * of letting every page underneath fire a wave of 401s. The token itself
 * lives server-side only (API_AUTH_TOKEN env var) — this form just
 * exchanges it once for the session cookie via POST /auth/login, and the
 * browser handles the cookie automatically from then on.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  const [token, setToken] = useState("");
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
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        setStatus("authenticated");
      } else if (res.status === 429) {
        setError("Too many attempts. Wait a few minutes and try again.");
      } else {
        setError("Invalid token.");
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
              Authentication required
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="operator-token">Operator token</Label>
                <div className="relative">
                  <KeyRound className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="operator-token"
                    type="password"
                    autoFocus
                    autoComplete="current-password"
                    className="pl-9"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="API_AUTH_TOKEN"
                  />
                </div>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={submitting || !token}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Unlock"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}

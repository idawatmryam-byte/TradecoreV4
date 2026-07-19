import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent, Button, Input, Label } from "@/components/ui";
import { useToast } from "@/components/ui/use-toast";
import {
  UserCircle2, Save, KeyRound, Loader2, ShieldCheck, Trash2, AlertTriangle, Link2, Copy, Check,
} from "lucide-react";

/**
 * Account manager — profile, security (password + linked sign-in providers),
 * and the danger zone. Talks to /me/account* with plain fetch (same pattern
 * as the auth gate: these endpoints live outside the generated API client).
 */

interface AccountInfo {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  hasPassword: boolean;
  providers: Array<{ provider: string; email: string | null }>;
}

const PROVIDER_LABEL: Record<string, string> = { google: "Google", apple: "Apple" };

export function Account() {
  const { toast } = useToast();
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // profile form
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  // password form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  // delete
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  // account ID copy-to-clipboard
  const [copied, setCopied] = useState(false);
  async function copyAccountId(accountId: string) {
    try {
      await navigator.clipboard.writeText(accountId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Couldn't copy", description: "Select and copy the ID manually.", variant: "destructive" });
    }
  }

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/me/account", { credentials: "same-origin" });
      if (res.ok) {
        const data = (await res.json()) as AccountInfo;
        setInfo(data);
        setDisplayName(data.displayName ?? "");
        setEmail(data.email ?? "");
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function saveProfile() {
    setSavingProfile(true);
    try {
      const res = await fetch("/api/me/account", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, email }),
      });
      if (res.ok) {
        toast({ title: "Profile Saved" });
        load();
      } else {
        const data = await res.json().catch(() => null);
        toast({ title: "Error", description: data?.error ?? "Failed to save profile.", variant: "destructive" });
      }
    } finally {
      setSavingProfile(false);
    }
  }

  async function savePassword() {
    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords don't match", description: "New password and confirmation must be identical.", variant: "destructive" });
      return;
    }
    setSavingPassword(true);
    try {
      const res = await fetch("/api/me/account/password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.ok) {
        toast({ title: info?.hasPassword ? "Password Changed" : "Password Set" });
        setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
        load();
      } else {
        const data = await res.json().catch(() => null);
        toast({ title: "Error", description: data?.error ?? "Failed to update password.", variant: "destructive" });
      }
    } finally {
      setSavingPassword(false);
    }
  }

  async function deleteAccount() {
    setDeleting(true);
    try {
      const res = await fetch("/api/me/account", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: deleteConfirm }),
      });
      if (res.ok) {
        window.location.href = import.meta.env.BASE_URL;
      } else {
        const data = await res.json().catch(() => null);
        toast({ title: "Error", description: data?.error ?? "Failed to delete account.", variant: "destructive" });
        setDeleting(false);
      }
    } catch {
      setDeleting(false);
    }
  }

  if (loading && !info) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center">
        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
      </div>
    );
  }
  if (!info) {
    return <p className="text-sm text-muted-foreground">Couldn't load your account. Refresh and try again.</p>;
  }

  const initial = (info.displayName || info.username).charAt(0).toUpperCase();
  const memberSince = new Date(info.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const accountId = `TC-${String(info.id).padStart(6, "0")}`;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <UserCircle2 className="h-6 w-6 text-primary" /> Account
        </h1>
        <p className="text-muted-foreground text-sm mt-1">Manage your profile, security, and connected sign-in methods.</p>
      </div>

      {/* ── Profile ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono tracking-wider uppercase">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-full bg-primary/15 border border-primary/40 flex items-center justify-center text-xl font-bold text-primary">
              {initial}
            </div>
            <div>
              <div className="font-semibold">{info.displayName || info.username}</div>
              <div className="text-xs text-muted-foreground font-mono">@{info.username} · member since {memberSince}</div>
              <button
                type="button"
                onClick={() => copyAccountId(accountId)}
                title="Copy Account ID"
                className="mt-1 inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
              >
                Account ID: <span className="text-foreground">{accountId}</span>
                {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Display Name</Label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="How should we call you?" />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
          </div>
          <Button onClick={saveProfile} disabled={savingProfile} className="gap-2">
            {savingProfile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Profile
          </Button>
        </CardContent>
      </Card>

      {/* ── Sign-in methods ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" /> Sign-in Methods
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div className="flex items-center gap-3">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Password</div>
                <div className="text-xs text-muted-foreground">
                  {info.hasPassword ? "Set — you can log in with username + password." : "Not set — you currently sign in with a linked provider only."}
                </div>
              </div>
            </div>
            <span className={`text-xs font-mono ${info.hasPassword ? "text-success" : "text-warning"}`}>
              {info.hasPassword ? "ACTIVE" : "NOT SET"}
            </span>
          </div>
          {info.providers.map((p) => (
            <div key={p.provider} className="flex items-center justify-between rounded-md border border-border p-3">
              <div className="flex items-center gap-3">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium">{PROVIDER_LABEL[p.provider] ?? p.provider}</div>
                  <div className="text-xs text-muted-foreground">{p.email ?? "Linked"}</div>
                </div>
              </div>
              <span className="text-xs font-mono text-success">LINKED</span>
            </div>
          ))}
          {info.providers.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No social accounts linked. Google/Apple sign-in buttons appear on the login page when the
              server operator has configured them.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Password ────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" /> {info.hasPassword ? "Change Password" : "Set a Password"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!info.hasPassword && (
            <p className="text-xs text-muted-foreground">
              Your account was created with a social sign-in. Setting a password adds a second way in —
              useful if you ever lose access to that provider.
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {info.hasPassword && (
              <div className="space-y-2">
                <Label>Current Password</Label>
                <Input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
              </div>
            )}
            <div className="space-y-2">
              <Label>New Password</Label>
              <Input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min. 12 characters" />
            </div>
            <div className="space-y-2">
              <Label>Confirm New Password</Label>
              <Input type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </div>
          </div>
          <Button
            onClick={savePassword}
            disabled={savingPassword || !newPassword || (info.hasPassword && !currentPassword)}
            className="gap-2"
          >
            {savingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {info.hasPassword ? "Change Password" : "Set Password"}
          </Button>
        </CardContent>
      </Card>

      {/* ── Danger zone ─────────────────────────────────────────────────────── */}
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" /> Danger Zone
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Deleting your account stops your bot immediately and permanently erases everything —
            trades, configuration, strategies, backtests, memory, and your encrypted Binance credentials.
            Open positions on the exchange are NOT closed automatically; close them on Binance first.
            This cannot be undone.
          </p>
          <div className="space-y-2">
            <Label>Type your username (<span className="font-mono">{info.username}</span>) to confirm</Label>
            <Input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} placeholder={info.username} />
          </div>
          <Button
            variant="destructive"
            onClick={deleteAccount}
            disabled={deleting || deleteConfirm !== info.username}
            className="gap-2"
          >
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Delete Account Permanently
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

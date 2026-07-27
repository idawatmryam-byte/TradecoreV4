import {
  useGetBinanceCredentials, useSetBinanceCredentials, useDeleteBinanceCredentials, getGetBinanceCredentialsQueryKey,
  useGetOandaCredentials, useSetOandaCredentials, useDeleteOandaCredentials, getGetOandaCredentialsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Button, Input, Label } from "@/components/ui";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import type { Section } from "@/lib/section";

/**
 * The broker connection cards, one per section's broker.
 *
 * These used to live inside `settings.tsx`. They moved here because the
 * onboarding wizard and the Upgrade-to-Live flow need the exact same thing:
 * collect this section's credentials and confirm the server accepted them.
 * Forking the markup would have meant three places to keep the (safety
 * critical, quite specific) copy in sync.
 *
 * There is no separate "test connection" endpoint — saving IS the check. The
 * server either accepts and encrypts the credential or errors, so `onSaved`
 * firing is the signal a caller can gate a Live switch on.
 */

/** True once this section's broker has a credential on file. */
export function useBrokerConfigured(section: Section): { configured: boolean; isLoading: boolean } {
  const forex = section === "forex";
  const binance = useGetBinanceCredentials({
    query: { queryKey: getGetBinanceCredentialsQueryKey(), enabled: !forex },
  });
  const oanda = useGetOandaCredentials({
    query: { queryKey: getGetOandaCredentialsQueryKey(), enabled: forex },
  });
  const q = forex ? oanda : binance;
  return { configured: !!q.data?.configured, isLoading: q.isLoading };
}

interface CredentialsCardProps {
  /** Fired after the server accepts and stores a credential. */
  onSaved?: () => void;
}

export function BinanceCredentialsCard({ onSaved }: CredentialsCardProps = {}) {
  const { data: status, isLoading } = useGetBinanceCredentials({ query: { queryKey: getGetBinanceCredentialsQueryKey() } });
  const setCredentials = useSetBinanceCredentials();
  const deleteCredentials = useDeleteBinanceCredentials();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetBinanceCredentialsQueryKey() });

  const handleSave = () => {
    if (!apiKey.trim() || !apiSecret.trim()) return;
    setCredentials.mutate({ data: { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() } }, {
      onSuccess: () => {
        setApiKey("");
        setApiSecret("");
        invalidate();
        toast({ title: "Binance Credentials Saved", description: "Restart the bot for the new credentials to take effect." });
        onSaved?.();
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to save Binance credentials.", variant: "destructive" });
      },
    });
  };

  const handleRemove = () => {
    deleteCredentials.mutate(undefined, {
      onSuccess: () => {
        invalidate();
        toast({ title: "Binance Credentials Removed" });
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to remove Binance credentials.", variant: "destructive" });
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" /> Your Binance API Credentials
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Your bot connects to Binance using YOUR OWN API key and secret — never a shared account. Stored encrypted;
          never displayed back once saved. Use testnet keys (<code className="text-xs font-mono">testnet.binance.vision</code>)
          while the Testnet toggle below is on.
        </p>

        {!isLoading && (
          <div className="text-xs font-mono text-muted-foreground">
            {status?.configured
              ? <>Currently configured — key ends in <span className="text-foreground">{status.apiKeyPreview}</span></>
              : "No Binance credentials configured yet."}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>API Key</Label>
            <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Enter new API key" />
          </div>
          <div className="space-y-2">
            <Label>API Secret</Label>
            <Input type="password" autoComplete="off" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder="Enter new API secret" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={setCredentials.isPending || !apiKey.trim() || !apiSecret.trim()}>
            {setCredentials.isPending ? "Saving..." : "Save Credentials"}
          </Button>
          {status?.configured && (
            <Button variant="destructive" onClick={handleRemove} disabled={deleteCredentials.isPending}>
              <Trash2 className="mr-2 h-4 w-4" /> Remove
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function OandaCredentialsCard({ onSaved }: CredentialsCardProps = {}) {
  const { data: status, isLoading } = useGetOandaCredentials({ query: { queryKey: getGetOandaCredentialsQueryKey() } });
  const setCredentials = useSetOandaCredentials();
  const deleteCredentials = useDeleteOandaCredentials();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [apiToken, setApiToken] = useState("");
  const [accountId, setAccountId] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetOandaCredentialsQueryKey() });

  const handleSave = () => {
    if (!apiToken.trim() || !accountId.trim()) return;
    setCredentials.mutate({ data: { apiToken: apiToken.trim(), accountId: accountId.trim() } }, {
      onSuccess: () => {
        setApiToken("");
        setAccountId("");
        invalidate();
        toast({ title: "OANDA Credentials Saved", description: "Restart the forex engine for the new credentials to take effect." });
        onSaved?.();
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to save OANDA credentials.", variant: "destructive" });
      },
    });
  };

  const handleRemove = () => {
    deleteCredentials.mutate(undefined, {
      onSuccess: () => {
        invalidate();
        toast({ title: "OANDA Credentials Removed" });
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to remove OANDA credentials.", variant: "destructive" });
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" /> Your OANDA Credentials
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          The forex engine connects to OANDA with YOUR OWN personal access token and account ID — create both free at{" "}
          <code className="text-xs font-mono">oanda.com</code> (open a <strong>practice</strong> account, then Manage
          API Access → generate a token). Any home currency works: a GBP or EUR account is converted to USD at live
          rates, and every number in the app (balance, Max Loss, P&L) stays in USD. Stored encrypted; never displayed
          back once saved. Practice tokens only work while the Practice toggle below is on — live needs a live token.
          Use a <strong>standard</strong> (v20) account — spread-betting sub-accounts have no API access.
        </p>

        {!isLoading && (
          <div className="text-xs font-mono text-muted-foreground">
            {status?.configured
              ? <>Currently configured — account ends in <span className="text-foreground">{status.accountIdPreview}</span></>
              : "No OANDA credentials configured yet."}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>API Token</Label>
            <Input type="password" autoComplete="off" value={apiToken} onChange={(e) => setApiToken(e.target.value)} placeholder="Enter personal access token" />
          </div>
          <div className="space-y-2">
            <Label>Account ID</Label>
            <Input type="text" autoComplete="off" value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="e.g. 101-001-1234567-001" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={setCredentials.isPending || !apiToken.trim() || !accountId.trim()}>
            {setCredentials.isPending ? "Saving..." : "Save Credentials"}
          </Button>
          {status?.configured && (
            <Button variant="destructive" onClick={handleRemove} disabled={deleteCredentials.isPending}>
              <Trash2 className="mr-2 h-4 w-4" /> Remove
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** The credentials card for whichever broker this section trades through. */
export function BrokerCredentialsCard({ section, onSaved }: { section: Section } & CredentialsCardProps) {
  return section === "forex"
    ? <OandaCredentialsCard onSaved={onSaved} />
    : <BinanceCredentialsCard onSaved={onSaved} />;
}

import {
  useGetConfig, useUpdateConfig, getGetConfigQueryKey,
  useGetBinanceCredentials, useSetBinanceCredentials, useDeleteBinanceCredentials, getGetBinanceCredentialsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Button, Input, Label, Switch } from "@/components/ui";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Settings as SettingsIcon, Save, TestTube2, KeyRound, Trash2, TrendingUp } from "lucide-react";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

// Quick-pick universe for the coin picker — 24 liquid USDT markets. Any pair
// not on this list can still be typed into the box below; unavailable symbols
// are dropped by the engine at scan time (it only trades listed markets).
const COIN_UNIVERSE = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT",
  "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "LTCUSDT", "TRXUSDT",
  "ATOMUSDT", "UNIUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT",
  "INJUSDT", "SUIUSDT", "TIAUSDT", "FILUSDT", "SEIUSDT", "AAVEUSDT",
];

// NOTE: how each strategy TRADES (dollar risk/target, stop & target levels,
// position size, hold time) is configured per strategy on the Strategies
// page. This page holds only account-level settings and the safety limits
// that protect the WHOLE account across every strategy.

function BinanceCredentialsCard() {
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

export function Settings() {
  const { data: config } = useGetConfig({ query: { queryKey: getGetConfigQueryKey() } });
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    marketType: "spot" as "spot" | "futures",
    leverage: 1,
    marginMode: "isolated" as "isolated" | "cross",
    maxOpenPositions: 5,
    dailyLossLimitUsdt: -10,
    scanIntervalSeconds: 15,
    pairs: "BTCUSDT,ETHUSDT",
    testnet: true,
    backtestMode: false,
    highFrequencyTestMode: false,
    alertWebhookUrl: "",
  });

  useEffect(() => {
    if (config) {
      setFormData({
        marketType: config.marketType,
        leverage: config.leverage,
        marginMode: config.marginMode,
        maxOpenPositions: config.maxOpenPositions,
        dailyLossLimitUsdt: config.dailyLossLimitUsdt,
        scanIntervalSeconds: config.scanIntervalSeconds,
        pairs: config.pairs.join(", "),
        testnet: config.testnet,
        backtestMode: config.backtestMode,
        highFrequencyTestMode: config.highFrequencyTestMode,
        alertWebhookUrl: config.alertWebhookUrl ?? "",
      });
    }
  }, [config]);

  const handleChange = (field: string, value: string | number | boolean) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const isFutures = formData.marketType === "futures";

  const handleSave = () => {
    const payload = {
      ...formData,
      pairs: formData.pairs.split(',').map(s => s.trim()).filter(Boolean)
    };
    
    updateConfig.mutate({ data: payload }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() });
        toast({
          title: "Configuration Saved",
          description: "Engine parameters have been updated.",
        });
      },
      onError: () => {
        toast({
          title: "Error",
          description: "Failed to update configuration.",
          variant: "destructive"
        });
      }
    });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <SettingsIcon className="h-6 w-6 text-primary" /> Account & Safety
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Account-level settings and the safety limits that protect your whole account.
          How each strategy trades — dollar risk, targets, hold time — lives on the Strategies page.
        </p>
      </div>

      <BinanceCredentialsCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" /> Market Type
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-xs text-muted-foreground">
            Spot trading is long-only, no leverage. Futures (USDⓈ-M) supports both long and short positions with
            configurable leverage. In futures, Position Size is your <strong>margin per trade</strong> — notional
            exposure = size × leverage — so losses can exceed your position size; use with caution.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Market Type</Label>
              <Select value={formData.marketType} onValueChange={(v) => handleChange("marketType", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="spot">Spot</SelectItem>
                  <SelectItem value="futures">Futures (USDⓈ-M)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Leverage {!isFutures && "(futures only)"}</Label>
              <Input
                type="number"
                min={1}
                max={125}
                disabled={!isFutures}
                value={formData.leverage}
                onChange={(e) => handleChange("leverage", Number(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label>Margin Mode {!isFutures && "(futures only)"}</Label>
              <Select
                value={formData.marginMode}
                onValueChange={(v) => handleChange("marginMode", v)}
                disabled={!isFutures}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="isolated">Isolated</SelectItem>
                  <SelectItem value="cross">Cross</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono tracking-wider uppercase">Risk & Sizing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-xs text-muted-foreground">
              Account-wide limits that apply across ALL strategies — the final safety net.
              Per-trade amounts, dollar risk and targets are set per strategy on the
              <strong> Strategies</strong> page.
            </p>
            <div className="space-y-2">
              <Label>Max Open Positions</Label>
              <Input 
                type="number" 
                value={formData.maxOpenPositions} 
                onChange={(e) => handleChange('maxOpenPositions', Number(e.target.value))} 
              />
            </div>
            <div className="space-y-2">
              <Label>Daily Loss Limit (USDT) (Circuit Breaker)</Label>
              <Input 
                type="number" 
                value={formData.dailyLossLimitUsdt} 
                onChange={(e) => handleChange('dailyLossLimitUsdt', Number(e.target.value))} 
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono tracking-wider uppercase">Strategy & Environment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              {(() => {
                const selected = formData.pairs
                  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
                const toggle = (sym: string) => {
                  const set = new Set(selected);
                  set.has(sym) ? set.delete(sym) : set.add(sym);
                  handleChange('pairs', Array.from(set).join(", "));
                };
                return (
                  <>
                    <Label>
                      Coins / Markets
                      <span className="text-muted-foreground font-normal">
                        {selected.length > 0 ? ` · ${selected.length} selected` : ""}
                      </span>
                    </Label>
                    <div className="flex flex-wrap gap-1.5">
                      {COIN_UNIVERSE.map((sym) => {
                        const on = selected.includes(sym);
                        return (
                          <button
                            type="button"
                            key={sym}
                            onClick={() => toggle(sym)}
                            className={cn(
                              "px-2 py-1 rounded text-xs font-mono border transition-colors",
                              on
                                ? "border-primary bg-primary/15 text-primary"
                                : "border-border text-muted-foreground hover:border-primary/50",
                            )}
                          >
                            {sym.replace("USDT", "")}
                          </button>
                        );
                      })}
                    </div>
                    <Input
                      type="text"
                      value={formData.pairs}
                      onChange={(e) => handleChange('pairs', e.target.value)}
                      placeholder="Click coins above, or type any pair(s), comma-separated"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Tip: more coins = more trade opportunities per day. Symbols not
                      listed on your selected market type are skipped automatically.
                    </p>
                  </>
                );
              })()}
            </div>
            
            <div className="pt-4 mt-4 border-t border-border space-y-4">
              <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
                <div className="space-y-0.5">
                  <Label className="text-sm font-bold flex items-center gap-2">
                    <TestTube2 className="h-4 w-4 text-warning" /> Binance Testnet
                  </Label>
                  <p className="text-xs text-muted-foreground font-mono">Execute trades using paper money.</p>
                </div>
                <Switch
                  checked={formData.testnet}
                  onCheckedChange={(v) => handleChange('testnet', v)}
                />
              </div>

              {/* High-frequency test mode — testnet only. Kept out of sight on
                  live keys since the engine ignores it there anyway. */}
              {formData.testnet && (
                <div className="flex items-center justify-between p-3 border border-warning/40 rounded-md bg-warning/5">
                  <div className="space-y-0.5 pr-3">
                    <Label className="text-sm font-bold flex items-center gap-2">
                      <TestTube2 className="h-4 w-4 text-warning" /> High-Frequency Test Mode
                    </Label>
                    <p className="text-xs text-muted-foreground font-mono">
                      Forces the engine to trade a lot (no cooldown/confidence floor,
                      fast exits, breaker off) to generate data and surface bugs.
                      Not a profitable setup — testnet only.
                    </p>
                  </div>
                  <Switch
                    checked={formData.highFrequencyTestMode}
                    onCheckedChange={(v) => handleChange('highFrequencyTestMode', v)}
                  />
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Risk Alerts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono tracking-wider uppercase">Risk Alerts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            When repeated risk violations are detected the engine pauses new entries and sends an alert.
            Paste a Discord, Telegram, or Slack incoming-webhook URL below to receive the notification.
            Leave blank to log the alert only (no external message sent).
          </p>
          <div className="space-y-2">
            <Label>Alert Webhook URL</Label>
            <Input
              type="url"
              placeholder="https://discord.com/api/webhooks/... or https://hooks.slack.com/..."
              value={formData.alertWebhookUrl}
              onChange={(e) => handleChange('alertWebhookUrl', e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Supported formats: Discord webhook (<code className="text-xs font-mono">content</code> field),
            Slack / generic (<code className="text-xs font-mono">text</code> field).
            The engine pauses after <strong>3 consecutive violations</strong> where actual loss exceeds
            expected max loss + fees. A manual restart of the engine clears the pause counter.
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-end pt-4">
        <Button size="lg" className="w-full md:w-auto font-mono uppercase tracking-widest font-bold" onClick={handleSave} disabled={updateConfig.isPending}>
          {updateConfig.isPending ? "Saving..." : <><Save className="mr-2 h-4 w-4" /> Deploy Configuration</>}
        </Button>
      </div>
    </div>
  );
}

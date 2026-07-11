import {
  useGetConfig, useUpdateConfig, getGetConfigQueryKey,
  useGetBinanceCredentials, useSetBinanceCredentials, useDeleteBinanceCredentials, getGetBinanceCredentialsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Button, Input, Label, Switch } from "@/components/ui";
import { Settings as SettingsIcon, Save, TestTube2, KeyRound, Trash2 } from "lucide-react";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";

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
    positionSizeUsdt: 10,
    maxOpenPositions: 5,
    dailyLossLimitUsdt: -10,
    confidenceThreshold: 65,
    stopLossPercent: 1.5,
    takeProfitPercent: 2.5,
    scanIntervalSeconds: 15,
    pairs: "BTCUSDT,ETHUSDT",
    testnet: true,
    backtestMode: false,
    alertWebhookUrl: "",
  });

  useEffect(() => {
    if (config) {
      setFormData({
        positionSizeUsdt: config.positionSizeUsdt,
        maxOpenPositions: config.maxOpenPositions,
        dailyLossLimitUsdt: config.dailyLossLimitUsdt,
        confidenceThreshold: config.confidenceThreshold,
        stopLossPercent: config.stopLossPercent,
        takeProfitPercent: config.takeProfitPercent,
        scanIntervalSeconds: config.scanIntervalSeconds,
        pairs: config.pairs.join(", "),
        testnet: config.testnet,
        backtestMode: config.backtestMode,
        alertWebhookUrl: config.alertWebhookUrl ?? "",
      });
    }
  }, [config]);

  const handleChange = (field: string, value: string | number | boolean) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

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
          <SettingsIcon className="h-6 w-6 text-primary" /> Engine Configuration
        </h1>
        <p className="text-muted-foreground text-sm mt-1">Adjust core trading parameters and risk management rules.</p>
      </div>

      <BinanceCredentialsCard />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono tracking-wider uppercase">Risk & Sizing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>Position Size (USDT)</Label>
              <Input 
                type="number" 
                value={formData.positionSizeUsdt} 
                onChange={(e) => handleChange('positionSizeUsdt', Number(e.target.value))} 
              />
            </div>
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
              <Label>Confidence Threshold (1-100)</Label>
              <Input 
                type="number" 
                value={formData.confidenceThreshold} 
                onChange={(e) => handleChange('confidenceThreshold', Number(e.target.value))} 
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Stop Loss %</Label>
                <Input 
                  type="number" 
                  step="0.1"
                  value={formData.stopLossPercent} 
                  onChange={(e) => handleChange('stopLossPercent', Number(e.target.value))} 
                />
              </div>
              <div className="space-y-2">
                <Label>Take Profit %</Label>
                <Input 
                  type="number" 
                  step="0.1"
                  value={formData.takeProfitPercent} 
                  onChange={(e) => handleChange('takeProfitPercent', Number(e.target.value))} 
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Pairs (comma-separated)</Label>
              <Input 
                type="text" 
                value={formData.pairs} 
                onChange={(e) => handleChange('pairs', e.target.value)} 
              />
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

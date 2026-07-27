import {
  useGetConfig, useUpdateConfig, getGetConfigQueryKey,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, Button, Input, Label, Switch } from "@/components/ui";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { PageHeader, PageTabs } from "@/components/patterns";
import { BrokerCredentialsCard, useBrokerConfigured } from "@/components/broker-credentials";
import { ModePicker, type TradingMode } from "@/components/mode-picker";
import { AutoPilotConfirmDialog } from "@/components/autopilot-confirm-dialog";
import { OnboardingWizard } from "@/components/onboarding-wizard";

/** Settings' two views. Separate routes, one destination. */
export const SETTINGS_TABS = [
  { href: "/settings", label: "Trading" },
  { href: "/account", label: "Profile" },
];
import { Settings as SettingsIcon, Save, TestTube2, ShieldCheck, TrendingUp, CandlestickChart, Bot, Plus, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import { useSection, type Section } from "@/lib/section";

// Quick-pick universe for the coin picker — 24 liquid USDT markets. Any pair
// not on this list can still be typed into the box below; unavailable symbols
// are dropped by the engine at scan time (it only trades listed markets).
const COIN_UNIVERSE = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT",
  "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "LTCUSDT", "TRXUSDT",
  "ATOMUSDT", "UNIUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT",
  "INJUSDT", "SUIUSDT", "TIAUSDT", "FILUSDT", "SEIUSDT", "AAVEUSDT",
];

// Forex quick-pick universe — v1 trades USD-QUOTED instruments only (the
// account is USD, so dollar risk math is exact): the four USD-quoted majors,
// gold/silver, and the US index CFDs. OANDA-native names.
const FOREX_UNIVERSE = [
  "EUR_USD", "GBP_USD", "AUD_USD", "NZD_USD",
  "XAU_USD", "XAG_USD", "SPX500_USD", "NAS100_USD", "US30_USD",
];

// NOTE: how each strategy TRADES (dollar risk/target, stop & target levels,
// position size, hold time) is configured per strategy on the Strategies
// page. This page holds only account-level settings and the safety limits
// that protect the WHOLE account across every strategy.

const MARKET_LABELS: Record<Section, string> = { crypto: "Crypto", forex: "Forex" };

/**
 * What a Demo section sees where the broker card would be.
 *
 * A user in Demo has no exchange connection and needs none, so showing them
 * API-key fields is not merely redundant — it reads as an unfinished setup
 * step and undercuts the whole point of Demo being a complete product rather
 * than a locked-down trial. Say what is true and offer the upgrade.
 */
function DemoBrokerNotice({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-success" /> Broker Connection
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">
          You&apos;re currently using Demo Trading. No exchange connection is required.
          Upgrade to Live Trading when you&apos;re ready.
        </p>
        <Button variant="outline" onClick={onUpgrade}>
          Upgrade to Live Trading
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Demo → Live for ONE section.
 *
 * Everything the user already chose — market list, mode, risk limits, alert
 * webhook — is preserved: this sends a partial config update carrying only
 * the execution target (and the mode, when the AutoPilot confirmation changed
 * it). The upgrade is per market by design, because `executionTarget` is a
 * per-section column: someone can reasonably run Crypto live while still
 * paper-trading Forex.
 */
function UpgradeToLiveCard({
  section, mode, onCancel, onUpgraded,
}: {
  section: Section;
  mode: TradingMode;
  onCancel: () => void;
  onUpgraded: () => void;
}) {
  const { configured } = useBrokerConfigured(section);
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const enable = (finalMode: TradingMode) => {
    updateConfig.mutate({ data: { executionTarget: "live", mode: finalMode } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() });
        toast({
          title: "Live trading enabled",
          description: `${MARKET_LABELS[section]} now places real orders. Nothing happens until you start the engine.`,
        });
        onUpgraded();
      },
      onError: () => {
        toast({ title: "Error", description: "Couldn't switch this section to live.", variant: "destructive" });
      },
    });
  };

  const handleEnable = () => {
    // The single case that earns an extra confirmation: real funds, traded
    // with no per-trade approval. Research and Co-Pilot carry over silently.
    if (mode === "autopilot") setConfirmOpen(true);
    else enable(mode);
  };

  return (
    <>
      <Card className="border-warning/40 bg-warning/5">
        <CardHeader>
          <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
            <TestTube2 className="h-4 w-4 text-warning" /> Upgrade {MARKET_LABELS[section]} to Live Trading
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Your market selection, mode and risk limits stay exactly as they are — the only
            thing this adds is a broker connection. Connect the account below, then enable
            live trading. Your other market is unaffected, and you can switch this section
            back to Demo at any time.
          </p>
        </CardContent>
      </Card>

      <BrokerCredentialsCard section={section} />

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleEnable} disabled={!configured || updateConfig.isPending}>
          {updateConfig.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Enable Live Trading
        </Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        {!configured && (
          <span className="text-xs text-muted-foreground">
            Save your credentials above to continue.
          </span>
        )}
      </div>

      <AutoPilotConfirmDialog
        open={confirmOpen}
        marketLabel={MARKET_LABELS[section]}
        onSwitchToCopilot={() => { setConfirmOpen(false); enable("copilot"); }}
        onContinueWithAutoPilot={() => { setConfirmOpen(false); enable("autopilot"); }}
      />
    </>
  );
}

/** Entry point to configuring the section this user has not set up yet. */
function AddMarketCard({ other, onAdd }: { other: Section; onAdd: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold">Also trade {MARKET_LABELS[other]}</div>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            Set {MARKET_LABELS[other]} up with its own execution target, mode and limits.
            The engine runs one market at a time — starting one stops the other.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onAdd} className="shrink-0">
          <Plus className="mr-2 h-4 w-4" /> Add Market
        </Button>
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
    marketType: "spot" as "spot" | "futures" | "forex",
    leverage: 1,
    marginMode: "isolated" as "isolated" | "cross",
    maxOpenPositions: 5,
    dailyLossLimitUsdt: -10,
    maxCorrelatedExposurePercent: 200,
    correlationThreshold: 0.7,
    correlationUnknownPolicy: "allow" as "allow" | "block",
    scanIntervalSeconds: 15,
    pairs: "BTCUSDT,ETHUSDT",
    executionTarget: "demo" as "demo" | "live",
    mode: "copilot" as "research" | "copilot" | "autopilot",
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
        maxCorrelatedExposurePercent: config.maxCorrelatedExposurePercent,
        correlationThreshold: config.correlationThreshold,
        correlationUnknownPolicy: config.correlationUnknownPolicy,
        scanIntervalSeconds: config.scanIntervalSeconds,
        pairs: config.pairs.join(", "),
        executionTarget: config.executionTarget,
        mode: config.mode,
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

  const { section, setSection } = useSection();
  const isForexSection = section === "forex";
  const isFutures = formData.marketType === "futures";
  const otherSection: Section = isForexSection ? "crypto" : "forex";

  // Demo → Live is a deliberate, credential-gated flow rather than a toggle;
  // Live → Demo stays instant. Demo and Live are execution targets for the
  // same account, not separate accounts, so stepping back must never be the
  // harder direction.
  const { configured: brokerConfigured } = useBrokerConfigured(section);
  const [upgrading, setUpgrading] = useState(false);
  const [liveConfirmOpen, setLiveConfirmOpen] = useState(false);
  const [addingMarket, setAddingMarket] = useState(false);

  const requestLive = () => {
    if (!brokerConfigured) { setUpgrading(true); return; }
    if (formData.mode === "autopilot") { setLiveConfirmOpen(true); return; }
    handleChange("executionTarget", "live");
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

  const header = (
    <>
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        description="Your broker connection and the safety limits that protect the whole account. How each strategy trades — dollar risk, targets, hold time — lives under Advanced → Strategies."
      />
      <PageTabs tabs={SETTINGS_TABS} />
    </>
  );

  // Until the real config arrives, `formData` holds placeholder defaults that
  // are NOT this user's settings — including a daily loss limit of -10 and a
  // two-coin pair list. Rendering them looks like a configuration readout and
  // invites someone to hit Save on values they never chose. Show skeletons.
  if (!config) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        {header}
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <CardContent className="p-6 space-y-3">
              <div className="h-4 w-40 rounded bg-muted animate-pulse" />
              <div className="h-9 w-full rounded bg-muted/60 animate-pulse" />
              <div className="h-9 w-2/3 rounded bg-muted/60 animate-pulse" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {header}

      {/* HOW THIS SECTION TRADES.
          The two decisions that define what the engine is allowed to do —
          who authorises a trade, and whether it costs real money. They were
          previously buried at the bottom of "Strategy & Environment", under
          the coin picker, which is a strange place for the most consequential
          controls on the page and made the mode choice effectively
          undiscoverable. They belong above the broker card too: in Demo
          neither broker nor keys are involved at all. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" /> How this section trades
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
        {/* WHO DECIDES.
            Every new section starts in Co-Pilot, and until now there was
            no way out of it from the UI — the column and PUT /config
            supported all three modes, but nothing rendered a control, so
            an account could never reach AutoPilot. Three named choices
            rather than a toggle: they are not two ends of one axis, and
            "off/on" would leave Research unreachable.

            The pipeline is identical in all three. Only the executor at
            the end differs, which is why this is a setting and not a
            different product. */}
        <div className="p-3 border rounded-md bg-muted/30 space-y-3">
          <div className="space-y-0.5">
            <Label className="text-sm font-bold flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" /> Who decides
            </Label>
            <p className="text-xs text-muted-foreground">
              The engine's analysis is the same in every mode. This only changes who authorises a trade.
            </p>
          </div>

          <ModePicker
            value={formData.mode}
            onChange={(m) => handleChange('mode', m)}
          />

          {formData.mode === 'autopilot' && formData.executionTarget === 'live' && (
            <p className="rounded border border-warning/40 bg-warning/5 px-2.5 py-2 text-xs text-warning">
              AutoPilot on a live account opens real positions with real money, without asking
              first. Your risk limits above are the only thing standing between it and your balance.
            </p>
          )}
        </div>

        {/* The primary choice a user makes: paper or real money. Demo is
            self-contained (no broker, no keys), so it sits above the
            broker-specific settings rather than inside them. */}
        <div className={`p-3 border rounded-md ${formData.executionTarget === 'demo' ? 'bg-muted/30' : 'border-warning/50 bg-warning/5'}`}>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 pr-3">
              <Label className="text-sm font-bold flex items-center gap-2">
                <TestTube2 className="h-4 w-4 text-warning" /> Execution
              </Label>
              <p className="text-xs text-muted-foreground font-mono">
                {formData.executionTarget === 'demo'
                  ? "DEMO — trades are simulated inside TradeCore on live market data. No broker, no API keys, no real money."
                  : "LIVE — real orders are placed through your connected broker with real money."}
              </p>
            </div>
            <Switch
              aria-label="Trade live with real money"
              checked={formData.executionTarget === 'live'}
              onCheckedChange={(v) => {
                if (v) requestLive();
                else handleChange('executionTarget', 'demo');
              }}
            />
          </div>
          {formData.executionTarget === 'demo' && (
            <p className="text-xs text-muted-foreground font-mono mt-2 pt-2 border-t border-border/60">
              Demo fills use the same model the backtester uses, so paper results and
              backtest results mean the same thing.
            </p>
          )}
        </div>
        </CardContent>
      </Card>

      {/* In Demo there is no broker and none is needed, so the key fields are
          replaced rather than merely disabled — see DemoBrokerNotice. */}
      {upgrading ? (
        <UpgradeToLiveCard
          section={section}
          mode={formData.mode}
          onCancel={() => setUpgrading(false)}
          onUpgraded={() => setUpgrading(false)}
        />
      ) : formData.executionTarget === 'demo' ? (
        <DemoBrokerNotice onUpgrade={() => setUpgrading(true)} />
      ) : (
        <BrokerCredentialsCard section={section} />
      )}

      <AddMarketCard
        other={otherSection}
        onAdd={() => { setSection(otherSection); setAddingMarket(true); }}
      />

      {isForexSection ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
              <CandlestickChart className="h-4 w-4 text-primary" /> Forex Market (OANDA)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              This section trades <strong>forex, gold and US indices on OANDA</strong> — long and short, margin-based
              (each instrument's own margin rate applies; there's no leverage setting to manage). Entries are placed as a
              single atomic order with stop-loss and take-profit attached, so a position can never exist unprotected.
              The engine observes real market hours: closed over the weekend (Fri–Sun 5pm New York), and metals/indices
              take a daily one-hour break.
            </p>
            <p className="text-xs text-muted-foreground">
              v1 trades <strong>USD-quoted instruments only</strong> (EUR/USD, XAU/USD, …) so dollar risk and P&L are
              exact in account dollars — same risk model, same strategy brains, same Decisions feed as the crypto section.
              Non-USD accounts (e.g. GBP) are supported: the balance is converted to USD at the live rate, so OANDA's own
              ledger will show the pound equivalents of the app's dollar numbers.
            </p>
          </CardContent>
        </Card>
      ) : (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" /> Market Type
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-xs text-muted-foreground">
            Spot trading is long-only, no leverage. Futures (USDⓈ-M) supports both long and short positions.
            In futures, Position Size is your <strong>margin per trade</strong> and Max Leverage is a{" "}
            <strong>safety cap, not a target</strong>: strategies choose the safest effective leverage for each
            individual trade — based on the coin's volatility, your dollar risk, and liquidation distance — and
            never exceed this cap. Their per-trade choice (and why) shows on the Decisions page.
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
              <Label>Max Leverage Cap {!isFutures && "(futures only)"}</Label>
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
      )}

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
              <Label>Daily Loss Limit ({isForexSection ? "USD" : "USDT"}) (Circuit Breaker)</Label>
              <Input 
                type="number" 
                value={formData.dailyLossLimitUsdt} 
                onChange={(e) => handleChange('dailyLossLimitUsdt', Number(e.target.value))} 
              />
            </div>
            {/* Correlated exposure: the cap the other three cannot see. Five
                "independent" longs across correlated majors is one position to
                the market, and no count/notional/direction cap notices. */}
            <div className="space-y-2">
              <Label>Max Correlated Exposure (% of balance)</Label>
              <Input
                type="number"
                value={formData.maxCorrelatedExposurePercent}
                onChange={(e) => handleChange('maxCorrelatedExposurePercent', Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Caps the total size of one correlated cluster — this trade plus every open
                position measured to be the same directional bet. 200% leaves it effectively off.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Correlation Threshold</Label>
              <Input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={formData.correlationThreshold}
                onChange={(e) => handleChange('correlationThreshold', Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                How alike two symbols must move to count as one bet. 0.70 is the conventional
                "strongly correlated" line.
              </p>
            </div>
            <div className="space-y-2">
              <Label>When Correlation Cannot Be Measured</Label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={formData.correlationUnknownPolicy}
                onChange={(e) => handleChange('correlationUnknownPolicy', e.target.value)}
              >
                <option value="allow">Allow the trade</option>
                <option value="block">Block the trade</option>
              </select>
              <p className="text-xs text-muted-foreground">
                A new pair has too little shared history to measure. It is never assumed to be
                uncorrelated — you choose whether to trade anyway.
              </p>
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
                const universe = isForexSection ? FOREX_UNIVERSE : COIN_UNIVERSE;
                return (
                  <>
                    <Label>
                      {isForexSection ? "Instruments" : "Coins / Markets"}
                      <span className="text-muted-foreground font-normal">
                        {selected.length > 0 ? ` · ${selected.length} selected` : ""}
                      </span>
                    </Label>
                    <div className="flex flex-wrap gap-1.5">
                      {universe.map((sym) => {
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
                            {isForexSection ? sym.replace("_", "/") : sym.replace("USDT", "")}
                          </button>
                        );
                      })}
                    </div>
                    <Input
                      type="text"
                      value={formData.pairs}
                      onChange={(e) => handleChange('pairs', e.target.value)}
                      placeholder={isForexSection
                        ? "Click instruments above, or type OANDA names (EUR_USD), comma-separated"
                        : "Click coins above, or type any pair(s), comma-separated"}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {isForexSection
                        ? "v1 trades USD-quoted instruments only — dollar risk and P&L stay exact in account dollars."
                        : "Tip: more coins = more trade opportunities per day. Symbols not listed on your selected market type are skipped automatically."}
                    </p>
                  </>
                );
              })()}
            </div>
            
            <div className="pt-4 mt-4 border-t border-border space-y-4">
              {/* Broker-side paper trading. Superseded by Demo for everyday use,
                  but kept: it is the only path that exercises REAL broker order
                  flow (rejections, minimum notional, partial fills), which an
                  internal simulation cannot rehearse. Hidden unless trading
                  live, where it is the safe first step. */}
              {formData.executionTarget === 'live' && (
              <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
                <div className="space-y-0.5 pr-3">
                  <Label className="text-sm font-bold flex items-center gap-2">
                    <TestTube2 className="h-4 w-4 text-warning" /> {isForexSection ? "OANDA Practice Account" : "Binance Testnet"}
                  </Label>
                  <p className="text-xs text-muted-foreground font-mono">
                    {isForexSection
                      ? "Route live orders to your practice account instead of the real one — real broker order flow, practice money."
                      : "Route live orders to Binance Testnet instead of the real exchange — real order flow, paper money. The recommended last step before real funds."}
                  </p>
                </div>
                <Switch
                  checked={formData.testnet}
                  onCheckedChange={(v) => handleChange('testnet', v)}
                />
              </div>
              )}

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

      {/* Flipping the Execution switch to Live while already in AutoPilot is
          the same decision as upgrading, so it gets the same confirmation. */}
      <AutoPilotConfirmDialog
        open={liveConfirmOpen}
        marketLabel={MARKET_LABELS[section]}
        onSwitchToCopilot={() => {
          setLiveConfirmOpen(false);
          setFormData((prev) => ({ ...prev, mode: 'copilot', executionTarget: 'live' }));
        }}
        onContinueWithAutoPilot={() => {
          setLiveConfirmOpen(false);
          handleChange('executionTarget', 'live');
        }}
      />

      {/* Adding the other market reuses the onboarding wizard with its market
          question skipped — one flow to maintain, and a returning user meets
          the same three questions they answered on day one. */}
      {addingMarket && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
          <OnboardingWizard
            presetMarket={otherSection}
            onDone={() => setAddingMarket(false)}
          />
        </div>
      )}
    </div>
  );
}

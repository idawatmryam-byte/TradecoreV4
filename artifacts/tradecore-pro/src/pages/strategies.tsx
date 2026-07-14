import { useState } from 'react';
import {
  useGetStrategies,
  useUpdateStrategyConfig,
  useGetStrategySignals,
  getGetStrategiesQueryKey,
  getGetStrategySignalsQueryKey,
  type StrategyInfo,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { TrendingUp, Target, Waves, Zap, ArrowUpDown, BarChart3, Edit2, X, Check, RefreshCw, Flame } from 'lucide-react';

// ── Strategy icon mapping ───────────────────────────────────────────────────

const STRATEGY_ICONS: Record<string, React.ElementType> = {
  momentum_breakout:   TrendingUp,
  trend_pullback:      ArrowUpDown,
  mean_reversion:      Waves,
  vwap_reversion:      Target,
  micro_scalping:      Zap,
  volatility_breakout: BarChart3,
  scalp_reversion:     Waves,
};

const REGIME_COLORS: Record<string, string> = {
  strong_trend:    'bg-success/15 text-success border-success/30',
  weak_trend:      'bg-primary/15 text-primary border-primary/30',
  range:           'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  high_volatility: 'bg-destructive/15 text-destructive border-destructive/30',
  low_volatility:  'bg-muted/50 text-muted-foreground border-muted',
};

// ── Edit form state ────────────────────────────────────────────────────────

interface EditState {
  enabled: boolean;
  riskPercent: string;
  confidenceThreshold: string;
  stopLossPercent: string;
  takeProfitPercent: string;
  maxConcurrentPositions: string;
  cooldownMinutes: string;
}

// ── Strategy card ──────────────────────────────────────────────────────────

function StrategyCard({ strategy, onSaved }: { strategy: StrategyInfo; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditState>({
    enabled:                strategy.config.enabled,
    riskPercent:            String(strategy.config.riskPercent),
    confidenceThreshold:    String(strategy.config.confidenceThreshold),
    stopLossPercent:        String(strategy.config.stopLossPercent),
    takeProfitPercent:      String(strategy.config.takeProfitPercent),
    maxConcurrentPositions: String(strategy.config.maxConcurrentPositions),
    cooldownMinutes:        String(strategy.config.cooldownMinutes),
  });

  const { mutate, isPending } = useUpdateStrategyConfig({
    mutation: {
      onSuccess: () => { setEditing(false); onSaved(); },
    },
  });

  const Icon = STRATEGY_ICONS[strategy.strategyId] ?? BarChart3;
  const perf = strategy.performance;
  const winRatePct = perf.winRate != null ? (perf.winRate * 100).toFixed(1) + '%' : '—';
  const pnlColor = perf.totalPnl >= 0 ? 'text-success' : 'text-destructive';

  function handleSave() {
    mutate({
      id: strategy.strategyId,
      data: {
        enabled:                form.enabled,
        riskPercent:            Number(form.riskPercent),
        confidenceThreshold:    Number(form.confidenceThreshold),
        stopLossPercent:        Number(form.stopLossPercent),
        takeProfitPercent:      Number(form.takeProfitPercent),
        maxConcurrentPositions: Number(form.maxConcurrentPositions),
        cooldownMinutes:        Number(form.cooldownMinutes),
      },
    });
  }

  function handleToggle(val: boolean) {
    mutate({ id: strategy.strategyId, data: { enabled: val } });
  }

  return (
    <Card className={cn('relative transition-all', !strategy.config.enabled && 'opacity-60')}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center">
              <Icon className="h-4 w-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold">{strategy.strategyName}</CardTitle>
              <div className="flex flex-wrap gap-1 mt-1">
                {strategy.supportedRegimes.map((r: string) => (
                  <span
                    key={r}
                    className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded border', REGIME_COLORS[r] ?? 'bg-muted text-muted-foreground border-muted')}
                  >
                    {r.replace('_', ' ')}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!editing && (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(true)}>
                <Edit2 className="h-3.5 w-3.5" />
              </Button>
            )}
            <Switch checked={strategy.config.enabled} onCheckedChange={handleToggle} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Performance row */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md bg-muted/40 p-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Trades</p>
            <p className="text-base font-mono font-semibold">{perf.totalTrades}</p>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Win Rate</p>
            <p className="text-base font-mono font-semibold">{winRatePct}</p>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">PnL</p>
            <p className={cn('text-base font-mono font-semibold', pnlColor)}>
              {perf.totalPnl >= 0 ? '+' : ''}{perf.totalPnl.toFixed(2)}
            </p>
          </div>
        </div>

        {/* Config display or edit form */}
        {editing ? (
          <div className="space-y-3 border rounded-lg p-3 bg-muted/20">
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  ['riskPercent', 'Risk %'],
                  ['confidenceThreshold', 'Min Confidence'],
                  ['stopLossPercent', 'Stop Loss %'],
                  ['takeProfitPercent', 'Take Profit %'],
                  ['maxConcurrentPositions', 'Max Concurrent'],
                  ['cooldownMinutes', 'Cooldown (min)'],
                ] as [keyof Omit<EditState, 'enabled'>, string][]
              ).map(([key, label]) => (
                <div key={key}>
                  <Label className="text-xs">{label}</Label>
                  <Input
                    className="h-7 text-xs mt-1"
                    value={form[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditing(false)}>
                <X className="h-3 w-3 mr-1" /> Cancel
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={isPending}>
                <Check className="h-3 w-3 mr-1" /> {isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1.5 text-[11px] text-muted-foreground">
            <span>Risk: <span className="text-foreground font-mono">{strategy.config.riskPercent}%</span></span>
            <span>Conf: <span className="text-foreground font-mono">{strategy.config.confidenceThreshold}</span></span>
            <span>Max: <span className="text-foreground font-mono">{strategy.config.maxConcurrentPositions}</span></span>
            <span>SL: <span className="text-foreground font-mono">{strategy.config.stopLossPercent}%</span></span>
            <span>TP: <span className="text-foreground font-mono">{strategy.config.takeProfitPercent}%</span></span>
            <span>CD: <span className="text-foreground font-mono">{strategy.config.cooldownMinutes}m</span></span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Live signals panel ─────────────────────────────────────────────────────

function SignalsPanel() {
  const { data: signals, isLoading, refetch } = useGetStrategySignals({
    query: { refetchInterval: 10_000, queryKey: getGetStrategySignalsQueryKey() }
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wider">Live Opportunities</h2>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading signals…</p>
      ) : !signals || signals.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm text-muted-foreground">No active signals — bot may be offline or scanning.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground uppercase tracking-wider">
                <th className="text-left py-2 pr-3 font-medium">Symbol</th>
                <th className="text-left py-2 pr-3 font-medium">Strategy</th>
                <th className="text-left py-2 pr-3 font-medium">Regime</th>
                <th className="text-right py-2 pr-3 font-medium">Conf</th>
                <th className="text-right py-2 pr-3 font-medium">RSI</th>
                <th className="text-right py-2 pr-3 font-medium">Vol×</th>
                <th className="text-right py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((sig, i) => (
                <tr key={`${sig.symbol}-${i}`} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="py-2 pr-3 font-mono font-semibold text-foreground">{sig.symbol}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{sig.strategyName ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <span className={cn('px-1.5 py-0.5 rounded border text-[10px] font-mono', REGIME_COLORS[sig.regime ?? ''] ?? 'bg-muted text-muted-foreground border-muted')}>
                      {sig.regime?.replace('_', ' ') ?? '—'}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono">
                    <span className={cn(
                      'font-semibold',
                      (sig.confidence ?? 0) >= 75 ? 'text-success' :
                      (sig.confidence ?? 0) >= 60 ? 'text-primary' : 'text-muted-foreground'
                    )}>
                      {sig.confidence?.toFixed(1) ?? '—'}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-muted-foreground">{sig.rsi?.toFixed(1) ?? '—'}</td>
                  <td className="py-2 pr-3 text-right font-mono text-muted-foreground">{sig.volumeRatio?.toFixed(2) ?? '—'}</td>
                  <td className="py-2 text-right">
                    <Badge variant={sig.status === 'watching' ? 'default' : 'secondary'} className="text-[10px]">
                      {sig.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Summary stat card ──────────────────────────────────────────────────────

function StatCard({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
        <p className={cn('text-2xl font-mono font-bold', className)}>{value}</p>
      </CardContent>
    </Card>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export function Strategies() {
  const { data: strategies, isLoading, refetch } = useGetStrategies({
    query: { refetchInterval: 30_000, queryKey: getGetStrategiesQueryKey() }
  });

  const activeCount   = strategies?.filter((s) => s.config.enabled).length ?? 0;
  const totalCount    = strategies?.length ?? 0;
  const combinedPnl   = strategies?.reduce((s, x) => s + x.performance.totalPnl, 0) ?? 0;
  const totalTrades   = strategies?.reduce((s, x) => s + x.performance.totalTrades, 0) ?? 0;
  const bestWinRate   = strategies
    ?.filter((s) => s.performance.winRate != null)
    .sort((a, b) => (b.performance.winRate ?? 0) - (a.performance.winRate ?? 0))[0]
    ?.performance.winRate;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Strategies</h1>
        <p className="text-sm text-muted-foreground mt-1">
          6 specialized algorithms running in parallel, each tuned for a specific market regime.
        </p>
      </div>

      {/* Live opportunities */}
      <Card>
        <CardContent className="pt-6">
          <SignalsPanel />
        </CardContent>
      </Card>

      {/* Summary stats */}
      {strategies && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Active" value={`${activeCount}/${totalCount}`} />
          <StatCard label="Total Trades" value={String(totalTrades)} />
          <StatCard
            label="Combined PnL"
            value={(combinedPnl >= 0 ? '+' : '') + combinedPnl.toFixed(2)}
            className={combinedPnl >= 0 ? 'text-success' : 'text-destructive'}
          />
          <StatCard
            label="Best Win Rate"
            value={bestWinRate != null ? (bestWinRate * 100).toFixed(1) + '%' : '—'}
            className="text-success"
          />
        </div>
      )}

      {/* Strategy grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="pt-6 h-48" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {(strategies ?? []).map((strategy) => (
            <StrategyCard key={strategy.strategyId} strategy={strategy} onSaved={refetch} />
          ))}
        </div>
      )}
    </div>
  );
}

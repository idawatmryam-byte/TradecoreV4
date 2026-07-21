/**
 * Strategy Builder — the no-code custom strategy editor.
 *
 * Users compose declarative entry rules (simple AND lists per side) from the
 * indicator vocabulary the engine already computes each scan, pick a stop
 * mode, and save. The server validates everything again (zod) and the new
 * strategy appears on the Strategies page — disabled, with no dollar plan,
 * and gated behind a completed backtest before it can trade live.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  useGetCustomStrategies,
  useCreateCustomStrategy,
  useUpdateCustomStrategy,
  useDeleteCustomStrategy,
  getGetCustomStrategiesQueryKey,
  getGetStrategiesQueryKey,
  type CustomStrategy,
  type CustomStrategyCondition,
  type CustomStrategyRules,
  type CustomStrategyStop,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useSection } from '@/lib/section';
import { useIsDemo } from '@/lib/account';
import { useToast } from '@/components/ui/use-toast';
import { Hammer, Plus, Trash2, Edit2, X, Check, FlaskConical, ShieldCheck, ShieldAlert, ArrowUp, ArrowDown } from 'lucide-react';

// ── Indicator vocabulary (mirror of api-server lib/customRules.ts — the
//    server re-validates, this only drives the form controls) ───────────────
const NUMERIC_INDICATORS: Record<string, { label: string; min: number; max: number; hint?: string }> = {
  rsi:             { label: 'RSI (14, 5m)',               min: 0,    max: 100, hint: '<30 oversold · >70 overbought' },
  adx:             { label: 'ADX (14, 5m)',               min: 0,    max: 100, hint: '>25 = trending' },
  atrPercent:      { label: 'ATR % of price (1m)',        min: 0,    max: 50,  hint: 'volatility' },
  macdHistogram:   { label: 'MACD histogram (3m)',        min: -1e9, max: 1e9, hint: '>0 bullish momentum' },
  volumeRatio:     { label: 'Volume vs 20-bar avg (1m)',  min: 0,    max: 1000, hint: '>1.5 = elevated' },
  confidence:      { label: 'Bullish vote score (0-100)', min: 0,    max: 100 },
  shortConfidence: { label: 'Bearish vote score (0-100)', min: 0,    max: 100 },
  lastPrice:       { label: 'Last price',                 min: 0,    max: 1e12 },
  hourUtc:         { label: 'Hour of day (UTC, 0-23)',    min: 0,    max: 23, hint: 'session filters' },
  pctFromHigh20:   { label: '% below 20-bar high (15m)',  min: 0,    max: 100 },
  pctFromLow20:    { label: '% above 20-bar low (15m)',   min: 0,    max: 100 },
};
const ENUM_INDICATORS: Record<string, { label: string; values: readonly string[] }> = {
  regime:          { label: 'Market regime', values: ['strong_trend', 'weak_trend', 'range', 'high_volatility', 'low_volatility'] },
  macroBullish:    { label: '1h macro bullish (price > EMA50)', values: ['true', 'false'] },
  macroBearish:    { label: '1h macro bearish (price < EMA50)', values: ['true', 'false'] },
  ema20AboveEma50: { label: 'EMA20 above EMA50 (5m)',           values: ['true', 'false'] },
};
const OPS: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' };

function describeCondition(c: CustomStrategyCondition): string {
  const label = NUMERIC_INDICATORS[c.indicator]?.label ?? ENUM_INDICATORS[c.indicator]?.label ?? c.indicator;
  return `${label} ${OPS[c.op] ?? c.op} ${String(c.value).replace('_', ' ')}`;
}

// ── Form state ──────────────────────────────────────────────────────────────
interface CondRow { indicator: string; op: string; value: string }
interface BuilderForm {
  name: string;
  description: string;
  long: CondRow[];
  short: CondRow[];
  stopMode: 'atr' | 'percent' | 'swing';
  atrMult: string;
  pct: string;
  lookback: string;
  confidence: number;
}

const EMPTY_FORM: BuilderForm = {
  name: '', description: '',
  long: [{ indicator: 'rsi', op: 'lt', value: '30' }],
  short: [],
  stopMode: 'atr', atrMult: '1.5', pct: '1.0', lookback: '20',
  confidence: 70,
};

function formFromStrategy(s: CustomStrategy): BuilderForm {
  const toRows = (list?: CustomStrategyCondition[]): CondRow[] =>
    (list ?? []).map((c) => ({ indicator: c.indicator, op: c.op, value: String(c.value) }));
  const stop = s.rules.stop;
  return {
    name: s.name,
    description: s.description ?? '',
    long: toRows(s.rules.long),
    short: toRows(s.rules.short),
    stopMode: stop.mode,
    atrMult: String(stop.atrMult ?? 1.5),
    pct: String(stop.pct ?? 1.0),
    lookback: String(stop.lookback ?? 20),
    confidence: s.rules.confidence,
  };
}

/** Assemble + client-validate the rule document. Returns rules or an error. */
function buildRules(form: BuilderForm): { rules?: CustomStrategyRules; error?: string } {
  const toConditions = (rows: CondRow[], side: string): CustomStrategyCondition[] | { error: string } => {
    const out: CustomStrategyCondition[] = [];
    for (const [i, r] of rows.entries()) {
      const numeric = NUMERIC_INDICATORS[r.indicator];
      const enumSpec = ENUM_INDICATORS[r.indicator];
      if (numeric) {
        const n = Number(r.value);
        if (!Number.isFinite(n)) return { error: `${side} rule ${i + 1}: enter a number for ${numeric.label}` };
        if (n < numeric.min || n > numeric.max) return { error: `${side} rule ${i + 1}: ${numeric.label} must be between ${numeric.min} and ${numeric.max}` };
        out.push({ indicator: r.indicator, op: r.op as CustomStrategyCondition['op'], value: n });
      } else if (enumSpec) {
        if (!enumSpec.values.includes(r.value)) return { error: `${side} rule ${i + 1}: pick a value for ${enumSpec.label}` };
        out.push({ indicator: r.indicator, op: 'eq', value: r.value });
      } else {
        return { error: `${side} rule ${i + 1}: unknown indicator` };
      }
    }
    return out;
  };

  const long = toConditions(form.long, 'Long');
  if ('error' in long) return { error: long.error };
  const short = toConditions(form.short, 'Short');
  if ('error' in short) return { error: short.error };
  if (long.length === 0 && short.length === 0) return { error: 'Add at least one condition on the long or short side.' };
  if (long.length > 8 || short.length > 8) return { error: 'At most 8 conditions per side.' };

  let stop: CustomStrategyStop;
  if (form.stopMode === 'atr') {
    const v = Number(form.atrMult);
    if (!(v >= 0.5 && v <= 10)) return { error: 'ATR multiple must be between 0.5 and 10.' };
    stop = { mode: 'atr', atrMult: v };
  } else if (form.stopMode === 'percent') {
    const v = Number(form.pct);
    if (!(v >= 0.05 && v <= 20)) return { error: 'Stop % must be between 0.05 and 20.' };
    stop = { mode: 'percent', pct: v };
  } else {
    const v = Number(form.lookback);
    if (!(Number.isInteger(v) && v >= 3 && v <= 50)) return { error: 'Swing lookback must be a whole number between 3 and 50.' };
    stop = { mode: 'swing', lookback: v };
  }

  return {
    rules: {
      ...(long.length > 0 ? { long } : {}),
      ...(short.length > 0 ? { short } : {}),
      stop,
      confidence: form.confidence,
    },
  };
}

/** Live natural-language preview of the rule document. */
function rulePreview(form: BuilderForm): string[] {
  const out: string[] = [];
  const sentence = (rows: CondRow[], side: string) => {
    if (rows.length === 0) return;
    const parts = rows.map((r) => {
      const label = NUMERIC_INDICATORS[r.indicator]?.label ?? ENUM_INDICATORS[r.indicator]?.label ?? r.indicator;
      const op = ENUM_INDICATORS[r.indicator] ? '=' : (OPS[r.op] ?? r.op);
      return `${label} ${op} ${r.value.replace('_', ' ') || '…'}`;
    });
    out.push(`${side} when ${parts.join(' AND ')}`);
  };
  sentence(form.long, 'LONG');
  sentence(form.short, 'SHORT');
  out.push(
    form.stopMode === 'atr' ? `Stop: ${form.atrMult || '…'}× ATR from entry` :
    form.stopMode === 'percent' ? `Stop: ${form.pct || '…'}% from entry` :
    `Stop: the ${form.lookback || '…'}-bar 15m swing level`,
  );
  out.push(`Signal confidence: ${form.confidence}`);
  return out;
}

// ── Condition row editor ────────────────────────────────────────────────────
function ConditionRow({ row, onChange, onRemove }: {
  row: CondRow;
  onChange: (r: CondRow) => void;
  onRemove: () => void;
}) {
  const numeric = NUMERIC_INDICATORS[row.indicator];
  const enumSpec = ENUM_INDICATORS[row.indicator];

  function setIndicator(ind: string) {
    if (ENUM_INDICATORS[ind]) {
      onChange({ indicator: ind, op: 'eq', value: ENUM_INDICATORS[ind]!.values[0]! });
    } else {
      onChange({ indicator: ind, op: numeric ? row.op : 'lt', value: '' });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        className="h-7 rounded-md border bg-background px-1.5 text-xs font-mono min-w-0 flex-1"
        value={row.indicator}
        onChange={(e) => setIndicator(e.target.value)}
      >
        <optgroup label="Numeric">
          {Object.entries(NUMERIC_INDICATORS).map(([id, spec]) => (
            <option key={id} value={id}>{spec.label}</option>
          ))}
        </optgroup>
        <optgroup label="State">
          {Object.entries(ENUM_INDICATORS).map(([id, spec]) => (
            <option key={id} value={id}>{spec.label}</option>
          ))}
        </optgroup>
      </select>

      {enumSpec ? (
        <>
          <span className="text-xs font-mono text-muted-foreground">=</span>
          <select
            className="h-7 rounded-md border bg-background px-1.5 text-xs font-mono"
            value={row.value}
            onChange={(e) => onChange({ ...row, value: e.target.value })}
          >
            {enumSpec.values.map((v) => (
              <option key={v} value={v}>{v.replace('_', ' ')}</option>
            ))}
          </select>
        </>
      ) : (
        <>
          <select
            className="h-7 rounded-md border bg-background px-1.5 text-xs font-mono"
            value={row.op}
            onChange={(e) => onChange({ ...row, op: e.target.value })}
          >
            <option value="gt">&gt;</option>
            <option value="gte">≥</option>
            <option value="lt">&lt;</option>
            <option value="lte">≤</option>
          </select>
          <Input
            className="h-7 text-xs w-20 font-mono"
            inputMode="decimal"
            placeholder="value"
            title={numeric ? `${numeric.min}–${numeric.max}${numeric.hint ? ` · ${numeric.hint}` : ''}` : undefined}
            value={row.value}
            onChange={(e) => onChange({ ...row, value: e.target.value })}
          />
        </>
      )}
      {numeric?.hint && <span className="text-[10px] text-muted-foreground hidden sm:inline">{numeric.hint}</span>}
      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onRemove}>
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

// ── Side (long/short) condition list ────────────────────────────────────────
function SideEditor({ side, rows, onChange }: {
  side: 'long' | 'short';
  rows: CondRow[];
  onChange: (rows: CondRow[]) => void;
}) {
  const isLong = side === 'long';
  return (
    <div className={cn('rounded-lg border p-3 space-y-2', rows.length > 0 ? (isLong ? 'border-success/40' : 'border-destructive/40') : 'border-dashed')}>
      <div className="flex items-center justify-between">
        <span className={cn('text-[11px] font-mono uppercase tracking-wider flex items-center gap-1', isLong ? 'text-success' : 'text-destructive')}>
          {isLong ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
          {isLong ? 'Long entry — ALL must hold' : 'Short entry — ALL must hold'}
        </span>
        {rows.length < 8 && (
          <Button
            variant="ghost" size="sm" className="h-6 text-[11px] font-mono"
            onClick={() => onChange([...rows, { indicator: 'rsi', op: isLong ? 'lt' : 'gt', value: isLong ? '30' : '70' }])}
          >
            <Plus className="h-3 w-3 mr-1" /> Condition
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No {side} entries — this side is off.</p>
      ) : (
        rows.map((row, i) => (
          <ConditionRow
            key={i}
            row={row}
            onChange={(r) => onChange(rows.map((x, j) => (j === i ? r : x)))}
            onRemove={() => onChange(rows.filter((_, j) => j !== i))}
          />
        ))
      )}
    </div>
  );
}

// ── Editor card (create or edit) ────────────────────────────────────────────
function EditorCard({ existing, onDone }: { existing?: CustomStrategy; onDone: () => void }) {
  const [form, setForm] = useState<BuilderForm>(existing ? formFromStrategy(existing) : EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetCustomStrategiesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
  };
  const { mutate: create, isPending: creating } = useCreateCustomStrategy({
    mutation: {
      onSuccess: () => { invalidate(); toast({ title: 'Strategy created', description: 'Set its trade plan on the Strategies page, then backtest it to unlock live trading.' }); onDone(); },
      onError: (e: any) => setError(e?.response?.data?.details?.join(' · ') ?? e?.response?.data?.error ?? 'Save failed'),
    },
  });
  const { mutate: update, isPending: updating } = useUpdateCustomStrategy({
    mutation: {
      onSuccess: () => { invalidate(); toast({ title: 'Strategy updated', description: 'Rule changes reset the backtest gate — run a new backtest before enabling it live.' }); onDone(); },
      onError: (e: any) => setError(e?.response?.data?.details?.join(' · ') ?? e?.response?.data?.error ?? 'Save failed'),
    },
  });

  const preview = useMemo(() => rulePreview(form), [form]);

  function handleSave() {
    setError(null);
    if (!form.name.trim()) { setError('Give the strategy a name.'); return; }
    const built = buildRules(form);
    if (built.error || !built.rules) { setError(built.error ?? 'Invalid rules'); return; }
    const payload = { name: form.name.trim(), description: form.description.trim() || undefined, rules: built.rules };
    if (existing) update({ id: existing.id, data: payload });
    else create({ data: payload });
  }

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Hammer className="h-4 w-4 text-primary" />
          {existing ? `Edit — ${existing.name}` : 'New custom strategy'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Name</Label>
            <Input className="h-8 text-xs mt-1" maxLength={60} placeholder="e.g. RSI Dip Hunter" value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <Label className="text-xs">Description (optional)</Label>
            <Input className="h-8 text-xs mt-1" maxLength={500} placeholder="What edge does it capture?" value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
        </div>

        <SideEditor side="long" rows={form.long} onChange={(long) => setForm((f) => ({ ...f, long }))} />
        <SideEditor side="short" rows={form.short} onChange={(short) => setForm((f) => ({ ...f, short }))} />

        {/* Stop placement */}
        <div className="rounded-lg border p-3 space-y-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Stop placement</span>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-7 rounded-md border bg-background px-1.5 text-xs font-mono"
              value={form.stopMode}
              onChange={(e) => setForm((f) => ({ ...f, stopMode: e.target.value as BuilderForm['stopMode'] }))}
            >
              <option value="atr">ATR multiple (volatility-scaled)</option>
              <option value="percent">Fixed % from entry</option>
              <option value="swing">Swing level (structure)</option>
            </select>
            {form.stopMode === 'atr' && (
              <><Input className="h-7 text-xs w-20 font-mono" inputMode="decimal" value={form.atrMult}
                onChange={(e) => setForm((f) => ({ ...f, atrMult: e.target.value }))} />
              <span className="text-[10px] text-muted-foreground">× ATR (0.5–10)</span></>
            )}
            {form.stopMode === 'percent' && (
              <><Input className="h-7 text-xs w-20 font-mono" inputMode="decimal" value={form.pct}
                onChange={(e) => setForm((f) => ({ ...f, pct: e.target.value }))} />
              <span className="text-[10px] text-muted-foreground">% from entry (0.05–20)</span></>
            )}
            {form.stopMode === 'swing' && (
              <><Input className="h-7 text-xs w-20 font-mono" inputMode="numeric" value={form.lookback}
                onChange={(e) => setForm((f) => ({ ...f, lookback: e.target.value }))} />
              <span className="text-[10px] text-muted-foreground">15m bars (3–50) — lowest low / highest high proves the thesis wrong</span></>
            )}
          </div>
        </div>

        {/* Confidence */}
        <div className="rounded-lg border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Signal confidence</span>
            <span className="text-xs font-mono font-semibold">{form.confidence}</span>
          </div>
          <input
            type="range" min={50} max={95} step={1}
            className="w-full accent-primary"
            value={form.confidence}
            onChange={(e) => setForm((f) => ({ ...f, confidence: Number(e.target.value) }))}
          />
          <p className="text-[10px] text-muted-foreground">
            The confidence each signal carries. The strategy's own Min Confidence threshold (Strategies page) still applies on top.
          </p>
        </div>

        {/* Live preview */}
        <div className="rounded-lg bg-muted/40 border border-border/60 p-3">
          <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">This strategy will</span>
          <ul className="mt-1.5 space-y-1">
            {preview.map((line, i) => (
              <li key={i} className="text-xs font-mono text-foreground">{line}</li>
            ))}
          </ul>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={onDone}>
            <X className="h-3.5 w-3.5 mr-1" /> Cancel
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={handleSave} disabled={creating || updating}>
            <Check className="h-3.5 w-3.5 mr-1" /> {creating || updating ? 'Saving…' : existing ? 'Save changes' : 'Create strategy'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Saved strategy card ─────────────────────────────────────────────────────
function SavedCard({ s, onEdit, onDeleted }: { s: CustomStrategy; onEdit: () => void; onDeleted: () => void }) {
  const isDemo = useIsDemo();
  const { toast } = useToast();
  const { mutate: remove, isPending } = useDeleteCustomStrategy({
    mutation: {
      onSuccess: () => { toast({ title: 'Strategy deleted' }); onDeleted(); },
      onError: (e: any) => toast({ title: 'Delete failed', description: e?.response?.data?.error ?? 'Try again', variant: 'destructive' }),
    },
  });

  return (
    <Card>
      <CardContent className="pt-4 pb-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold flex items-center gap-2 flex-wrap">
              {s.name}
              <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border bg-primary/10 text-primary border-primary/40">Custom</span>
              {s.backtested ? (
                <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border bg-success/10 text-success border-success/40 flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3" /> Backtested
                </span>
              ) : (
                <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border bg-yellow-500/10 text-yellow-400 border-yellow-500/40 flex items-center gap-1">
                  <ShieldAlert className="h-3 w-3" /> Test before live
                </span>
              )}
            </p>
            {s.description && <p className="text-[11px] text-muted-foreground mt-0.5">{s.description}</p>}
          </div>
          {!isDemo && (
            <div className="flex items-center gap-1 shrink-0">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit}>
                <Edit2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                disabled={isPending}
                onClick={() => { if (window.confirm(`Delete "${s.name}"? Its rules and settings are removed; its trade history stays in the Trade Log.`)) remove({ id: s.id }); }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-1">
          {(s.rules.long ?? []).map((c, i) => (
            <span key={`l${i}`} className="text-[10px] px-1.5 py-0.5 rounded border bg-success/10 text-success border-success/30 font-mono">
              ▲ {describeCondition(c)}
            </span>
          ))}
          {(s.rules.short ?? []).map((c, i) => (
            <span key={`s${i}`} className="text-[10px] px-1.5 py-0.5 rounded border bg-destructive/10 text-destructive border-destructive/30 font-mono">
              ▼ {describeCondition(c)}
            </span>
          ))}
          <span className="text-[10px] px-1.5 py-0.5 rounded border bg-muted/60 text-muted-foreground border-border font-mono">
            {s.rules.stop.mode === 'atr' ? `Stop ${s.rules.stop.atrMult}× ATR` :
             s.rules.stop.mode === 'percent' ? `Stop ${s.rules.stop.pct}%` :
             `Stop ${s.rules.stop.lookback}-bar swing`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={`/backtest?strategy=${s.strategyId}`}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md border border-dashed text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors"
          >
            <FlaskConical className="h-3 w-3" /> {s.backtested ? 'Backtest again' : 'Backtest now'}
          </Link>
          <Link
            href="/strategies"
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md border border-dashed text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors"
          >
            Trade plan →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export function StrategyBuilder() {
  const { section } = useSection();
  const isDemo = useIsDemo();
  const queryClient = useQueryClient();
  const { data: strategies, isLoading } = useGetCustomStrategies({
    query: { queryKey: [...getGetCustomStrategiesQueryKey(), section] },
  });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CustomStrategy | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetCustomStrategiesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto" key={section}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Hammer className="h-6 w-6 text-primary" /> Strategy Builder
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Build your own {section === 'forex' ? 'forex' : 'crypto'} strategy from the engine's indicators — no code.
            New strategies start disabled and must pass a backtest before trading live.
          </p>
        </div>
        {!isDemo && !editorOpen && (
          <Button size="sm" className="gap-1.5 font-mono text-xs" onClick={() => { setEditing(null); setEditorOpen(true); }}>
            <Plus className="h-3.5 w-3.5" /> New strategy
          </Button>
        )}
      </div>

      {isDemo && (
        <p className="text-xs text-muted-foreground border border-dashed rounded-lg p-3">
          Demo mode is read-only — the example below shows what a custom strategy looks like. Create a free account to build your own.
        </p>
      )}

      {editorOpen && (
        <EditorCard
          existing={editing ?? undefined}
          onDone={() => { setEditorOpen(false); setEditing(null); refresh(); }}
        />
      )}

      {isLoading ? (
        <Card className="animate-pulse"><CardContent className="pt-6 h-32" /></Card>
      ) : !strategies || strategies.length === 0 ? (
        !editorOpen && (
          <div className="rounded-lg border border-dashed p-10 text-center space-y-2">
            <Hammer className="h-8 w-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">No custom strategies yet in the {section} section.</p>
            {!isDemo && (
              <Button size="sm" variant="outline" className="font-mono text-xs" onClick={() => setEditorOpen(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Build your first strategy
              </Button>
            )}
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {strategies.map((s) => (
            <SavedCard
              key={s.id}
              s={s}
              onEdit={() => { setEditing(s); setEditorOpen(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
              onDeleted={refresh}
            />
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground border-t pt-3">
        How it works: your rules are stored as data and run by the same engine pipeline as the built-in strategies —
        the dollar-risk sizing, cost gates and safety controls all still apply, and every signal appears in the
        Decisions feed with each condition's observed value. Developers can also implement the Strategy interface
        directly in TypeScript for logic beyond what the builder expresses.
      </p>
    </div>
  );
}

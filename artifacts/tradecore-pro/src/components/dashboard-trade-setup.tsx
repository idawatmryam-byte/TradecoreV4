import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetConfigQueryKey,
  useGetConfig,
  useUpdateConfig,
  type BotConfig,
  type BotConfigUpdate,
} from "@workspace/api-client-react";
import { Gauge, Loader2, Save, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useToast } from "@/components/ui/use-toast";
import { useSection } from "@/lib/section";
import { cn } from "@/lib/utils";

const CADENCE_PRESETS = [
  {
    id: "deliberate",
    label: "Deliberate",
    detail: "Check every 60s · 30m symbol cooldown",
    scanIntervalSeconds: 60,
    cooldownMinutes: 30,
  },
  {
    id: "balanced",
    label: "Balanced",
    detail: "Check every 15s · 15m symbol cooldown",
    scanIntervalSeconds: 15,
    cooldownMinutes: 15,
  },
  {
    id: "fast",
    label: "Fast",
    detail: "Check every 5s · 5m symbol cooldown",
    scanIntervalSeconds: 5,
    cooldownMinutes: 5,
  },
] as const;

type CadenceId = (typeof CADENCE_PRESETS)[number]["id"] | "custom";

interface TradeSetupForm {
  positionSizeUsdt: string;
  riskPercent: string;
  maxOpenPositions: string;
  confidenceThreshold: string;
  riskModel: "percent" | "dollar";
  stopLossPercent: string;
  takeProfitPercent: string;
  maxLossUsdt: string;
  targetProfitUsdt: string;
  scanIntervalSeconds: string;
  cooldownMinutes: string;
  pairs: string;
}

function fromConfig(config: BotConfig): TradeSetupForm {
  return {
    positionSizeUsdt: String(config.positionSizeUsdt),
    riskPercent: String(config.riskPercent),
    maxOpenPositions: String(config.maxOpenPositions),
    confidenceThreshold: String(config.confidenceThreshold),
    riskModel: config.riskModel,
    stopLossPercent: String(config.stopLossPercent),
    takeProfitPercent: String(config.takeProfitPercent),
    maxLossUsdt: String(config.maxLossUsdt),
    targetProfitUsdt: String(config.targetProfitUsdt),
    scanIntervalSeconds: String(config.scanIntervalSeconds),
    cooldownMinutes: String(config.cooldownMinutes),
    pairs: config.pairs.join(", "),
  };
}

function finiteNumber(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function integer(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = finiteNumber(value, label, minimum, maximum);
  if (!Number.isInteger(parsed))
    throw new Error(`${label} must be a whole number.`);
  return parsed;
}

function cadenceFor(form: TradeSetupForm): CadenceId {
  const scan = Number(form.scanIntervalSeconds);
  const cooldown = Number(form.cooldownMinutes);
  return (
    CADENCE_PRESETS.find(
      (preset) =>
        preset.scanIntervalSeconds === scan &&
        preset.cooldownMinutes === cooldown,
    )?.id ?? "custom"
  );
}

export function DashboardTradeSetup({
  readOnly,
  autopilotActive,
  onSaved,
}: {
  readOnly: boolean;
  autopilotActive: boolean;
  onSaved: () => Promise<void>;
}) {
  const { section } = useSection();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const configQuery = useGetConfig();
  const updateConfig = useUpdateConfig();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<TradeSetupForm | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (configQuery.data) setForm(fromConfig(configQuery.data));
  }, [configQuery.data, open]);

  const cadence = useMemo(() => (form ? cadenceFor(form) : "custom"), [form]);

  function field<K extends keyof TradeSetupForm>(
    name: K,
    value: TradeSetupForm[K],
  ) {
    setForm((current) => (current ? { ...current, [name]: value } : current));
  }

  function applyCadence(id: Exclude<CadenceId, "custom">) {
    const preset = CADENCE_PRESETS.find((item) => item.id === id)!;
    setForm((current) =>
      current
        ? {
            ...current,
            scanIntervalSeconds: String(preset.scanIntervalSeconds),
            cooldownMinutes: String(preset.cooldownMinutes),
          }
        : current,
    );
  }

  function save() {
    const currentConfig = configQuery.data;
    if (!form || !currentConfig) return;
    setError(null);
    try {
      const pairs = [
        ...new Set(
          form.pairs
            .split(/[,\s]+/)
            .map((symbol) => symbol.trim().toUpperCase())
            .filter(Boolean),
        ),
      ];
      if (pairs.length === 0)
        throw new Error("Select at least one market symbol.");
      const data: BotConfigUpdate = {
        positionSizeUsdt: finiteNumber(
          form.positionSizeUsdt,
          "Position size",
          1,
          1_000_000,
        ),
        riskPercent:
          form.riskModel === "percent"
            ? finiteNumber(form.riskPercent, "Risk per trade", 0, 10)
            : currentConfig.riskPercent,
        maxOpenPositions: integer(
          form.maxOpenPositions,
          "Maximum open positions",
          1,
          50,
        ),
        confidenceThreshold: integer(
          form.confidenceThreshold,
          "Minimum confidence",
          0,
          100,
        ),
        riskModel: form.riskModel,
        stopLossPercent:
          form.riskModel === "percent"
            ? finiteNumber(form.stopLossPercent, "Stop loss", 0.01, 20)
            : currentConfig.stopLossPercent,
        takeProfitPercent:
          form.riskModel === "percent"
            ? finiteNumber(form.takeProfitPercent, "Take profit", 0.3, 100)
            : currentConfig.takeProfitPercent,
        maxLossUsdt:
          form.riskModel === "dollar"
            ? finiteNumber(form.maxLossUsdt, "Maximum loss", 0.01, 1_000_000)
            : currentConfig.maxLossUsdt,
        targetProfitUsdt:
          form.riskModel === "dollar"
            ? finiteNumber(
                form.targetProfitUsdt,
                "Target profit",
                0.01,
                1_000_000,
              )
            : currentConfig.targetProfitUsdt,
        scanIntervalSeconds: integer(
          form.scanIntervalSeconds,
          "Scan interval",
          5,
          3_600,
        ),
        cooldownMinutes: integer(
          form.cooldownMinutes,
          "Symbol cooldown",
          0,
          1_440,
        ),
        pairs,
      };
      updateConfig.mutate(
        { data },
        {
          onSuccess: async () => {
            await queryClient.invalidateQueries({
              queryKey: getGetConfigQueryKey(),
            });
            await onSaved();
            setOpen(false);
            toast({
              title: "Trade setup saved",
              description:
                "Co-Pilot and the next authorized AutoPilot setup now use this shared configuration.",
            });
          },
          onError: (mutationError) => setError(mutationError.message),
        },
      );
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : "Trade setup is invalid.",
      );
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline">
          <SlidersHorizontal className="mr-2 h-4 w-4" /> Trade setup
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="pr-8">
          <SheetTitle>Co-Pilot &amp; AutoPilot trade setup</SheetTitle>
          <SheetDescription>
            One shared setup controls how new trade plans are sized, protected,
            filtered, and scanned in both modes.
          </SheetDescription>
        </SheetHeader>

        {configQuery.error ? (
          <div
            className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm"
            role="alert"
          >
            <strong className="block text-destructive">
              Trade setup is unavailable
            </strong>
            <p className="mt-1 leading-6 text-muted-foreground">
              {configQuery.error.message}
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() => configQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : configQuery.isLoading || !form ? (
          <div
            className="grid min-h-72 place-items-center text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading current
            setup
          </div>
        ) : (
          <div className="mt-6 space-y-6 pb-24">
            {autopilotActive && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm leading-6">
                <strong className="block">
                  AutoPilot is currently authorized.
                </strong>
                Pause it before changing this setup. Active mandate limits
                remain immutable and are never rewritten silently.
              </div>
            )}

            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Gauge className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold">Opportunity cadence</h3>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                This changes how often Cactus checks for setups and how soon it
                may reconsider the same symbol. It never guarantees a trade or
                bypasses confidence, risk, market-data, or execution checks.
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                {CADENCE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={cadence === preset.id}
                    onClick={() => applyCadence(preset.id)}
                    className={cn(
                      "min-h-20 rounded-lg border p-3 text-left text-xs transition-colors",
                      cadence === preset.id
                        ? "border-primary bg-primary/10"
                        : "hover:bg-muted/50",
                    )}
                  >
                    <strong className="block text-sm">{preset.label}</strong>
                    <span className="mt-1 block leading-5 text-muted-foreground">
                      {preset.detail}
                    </span>
                  </button>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium">
                  Check every (seconds)
                  <Input
                    type="number"
                    min={5}
                    max={3600}
                    value={form.scanIntervalSeconds}
                    onChange={(event) =>
                      field("scanIntervalSeconds", event.target.value)
                    }
                    className="mt-1.5"
                  />
                </label>
                <label className="text-xs font-medium">
                  Same-symbol cooldown (minutes)
                  <Input
                    type="number"
                    min={0}
                    max={1440}
                    value={form.cooldownMinutes}
                    onChange={(event) =>
                      field("cooldownMinutes", event.target.value)
                    }
                    className="mt-1.5"
                  />
                </label>
              </div>
            </section>

            <section className="space-y-3 border-t pt-5">
              <h3 className="text-sm font-semibold">Markets &amp; filters</h3>
              <Label htmlFor="dashboard-markets">Symbols</Label>
              <Input
                id="dashboard-markets"
                value={form.pairs}
                onChange={(event) => field("pairs", event.target.value)}
                className="font-mono"
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium">
                  Minimum confidence (%)
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={form.confidenceThreshold}
                    onChange={(event) =>
                      field("confidenceThreshold", event.target.value)
                    }
                    className="mt-1.5"
                  />
                </label>
                <label className="text-xs font-medium">
                  Maximum open positions
                  <Input
                    type="number"
                    min={1}
                    max={50}
                    value={form.maxOpenPositions}
                    onChange={(event) =>
                      field("maxOpenPositions", event.target.value)
                    }
                    className="mt-1.5"
                  />
                </label>
              </div>
            </section>

            <section className="space-y-3 border-t pt-5">
              <h3 className="text-sm font-semibold">Size &amp; protection</h3>
              <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/20 p-1">
                {(["percent", "dollar"] as const).map((model) => (
                  <button
                    key={model}
                    type="button"
                    aria-pressed={form.riskModel === model}
                    onClick={() => field("riskModel", model)}
                    className={cn(
                      "min-h-10 rounded-md px-3 text-xs font-semibold capitalize",
                      form.riskModel === model && "bg-background shadow-sm",
                    )}
                  >
                    {model === "percent" ? "Percentage model" : "Dollar model"}
                  </button>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium">
                  Position size (USDT)
                  <Input
                    type="number"
                    min={1}
                    value={form.positionSizeUsdt}
                    onChange={(event) =>
                      field("positionSizeUsdt", event.target.value)
                    }
                    className="mt-1.5"
                  />
                </label>
                {form.riskModel === "percent" ? (
                  <>
                    <label className="text-xs font-medium">
                      Account risk per trade (%)
                      <Input
                        type="number"
                        min={0}
                        max={10}
                        step="0.1"
                        value={form.riskPercent}
                        onChange={(event) =>
                          field("riskPercent", event.target.value)
                        }
                        className="mt-1.5"
                      />
                      <span className="mt-1.5 block font-normal leading-5 text-muted-foreground">
                        Maximum account balance that may be lost on one trade.
                        This is not the stop-loss distance.
                      </span>
                    </label>
                    <label className="text-xs font-medium">
                      Stop loss distance (%)
                      <Input
                        type="number"
                        min={0.01}
                        max={20}
                        step="0.01"
                        value={form.stopLossPercent}
                        onChange={(event) =>
                          field("stopLossPercent", event.target.value)
                        }
                        className="mt-1.5"
                      />
                    </label>
                    <label className="text-xs font-medium">
                      Take profit distance (%)
                      <Input
                        type="number"
                        min={0.3}
                        max={100}
                        step="0.01"
                        value={form.takeProfitPercent}
                        onChange={(event) =>
                          field("takeProfitPercent", event.target.value)
                        }
                        className="mt-1.5"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="text-xs font-medium">
                      Maximum loss (USDT)
                      <Input
                        type="number"
                        min={0.01}
                        value={form.maxLossUsdt}
                        onChange={(event) =>
                          field("maxLossUsdt", event.target.value)
                        }
                        className="mt-1.5"
                      />
                    </label>
                    <label className="text-xs font-medium">
                      Target profit (USDT)
                      <Input
                        type="number"
                        min={0.01}
                        value={form.targetProfitUsdt}
                        onChange={(event) =>
                          field("targetProfitUsdt", event.target.value)
                        }
                        className="mt-1.5"
                      />
                    </label>
                  </>
                )}
              </div>
              {form.riskModel === "dollar" && (
                <p className="m-0 text-xs leading-5 text-muted-foreground">
                  Dollar Model uses Maximum loss and Target profit for each
                  trade. Percentage account risk and percentage stop distances
                  are not used.
                </p>
              )}
            </section>

            {error && (
              <p
                className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            )}
          </div>
        )}

        <SheetFooter className="sticky bottom-0 -mx-6 border-t bg-background/95 px-6 py-4 backdrop-blur">
          <Button
            onClick={save}
            disabled={
              readOnly || autopilotActive || !form || updateConfig.isPending
            }
          >
            {updateConfig.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save shared setup
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

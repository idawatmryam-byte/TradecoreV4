import type { FillCosts } from "../../execution/fillModel";
import type { StrategyConfig } from "../../strategies";
import { sha256Fingerprint } from "../canonical";
import type {
  ResearchExperimentManifest,
  ResearchStressScenario,
} from "./types";

const MINUTE_MS = 60_000;

export interface ResearchScenarioFillCosts extends FillCosts {
  modeledSlippageRate: number;
  spreadRate: number;
}

export function buildResearchScenarioFillCosts(
  base: Pick<FillCosts, "feeRate" | "makerFeeRate" | "slippageRate"> & {
    spreadRate?: number;
  },
  scenario: ResearchStressScenario,
): ResearchScenarioFillCosts {
  const latencyPenalty = base.slippageRate * (scenario.latencyMs / MINUTE_MS);
  const modeledSlippageRate =
    base.slippageRate * scenario.slippageMultiplier + latencyPenalty;
  const spreadRate = (base.spreadRate ?? 0) * scenario.spreadMultiplier;
  return {
    feeRate: base.feeRate * scenario.feeMultiplier,
    makerFeeRate: base.makerFeeRate * scenario.feeMultiplier,
    slippageRate: modeledSlippageRate + spreadRate,
    modeledSlippageRate,
    spreadRate,
  };
}

export function buildResearchScenarioConfigs(
  configs: ReadonlyMap<string, StrategyConfig>,
  scenario: ResearchStressScenario,
): Map<string, StrategyConfig> {
  return new Map(
    [...configs].map(([strategyId, config]) => [
      strategyId,
      scenario.adverseIntrabarOrdering
        ? {
            ...config,
            exitPriority: [
              "stop_loss",
              "trailing_stop",
              "take_profit",
              "timeout",
            ],
          }
        : { ...config, exitPriority: [...config.exitPriority] },
    ]),
  );
}

export function shouldDropResearchFrame(
  scenario: ResearchStressScenario,
  manifest: ResearchExperimentManifest,
  symbol: string,
  timestamp: number,
): boolean {
  if (scenario.missingDataFraction <= 0) return false;
  const bucket =
    Number.parseInt(
      sha256Fingerprint({
        seed: manifest.deterministicSeed,
        scenario: scenario.scenarioId,
        symbol,
        timestamp,
      }).slice(0, 8),
      16,
    ) / 0xffffffff;
  return bucket < scenario.missingDataFraction;
}

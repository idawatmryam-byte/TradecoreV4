import assert from "node:assert/strict";
import { applyStrategyAssignmentPolicy } from "../src/lib/strategyAssignmentPolicy";

const configs = new Map([
  ["alpha", { enabled: true, risk: 1 }],
  ["beta", { enabled: true, risk: 2 }],
  ["disabled", { enabled: false, risk: 3 }],
]);
const assignments = [
  { strategyId: "alpha", brain: true, copilot: false, autopilot: false },
  { strategyId: "beta", brain: false, copilot: true, autopilot: false },
  { strategyId: "disabled", brain: true, copilot: true, autopilot: true },
];

const brain = applyStrategyAssignmentPolicy("research", configs, assignments);
assert.equal(brain.get("alpha")?.enabled, true);
assert.equal(brain.get("beta")?.enabled, false);
assert.equal(brain.get("disabled")?.enabled, false, "assignment cannot enable a disabled strategy");

const copilot = applyStrategyAssignmentPolicy("copilot", configs, assignments);
assert.equal(copilot.get("alpha")?.enabled, false);
assert.equal(copilot.get("beta")?.enabled, true);

const autopilot = applyStrategyAssignmentPolicy("autopilot", configs, assignments);
assert.deepEqual(
  [...autopilot],
  [...configs],
  "a Dashboard assignment must not change the active AutoPilot execution set",
);
assert.notEqual(autopilot, configs, "callers receive an isolated map without changing authority semantics");

console.log("PASS: strategy assignments filter intelligence modes without changing AutoPilot authority");

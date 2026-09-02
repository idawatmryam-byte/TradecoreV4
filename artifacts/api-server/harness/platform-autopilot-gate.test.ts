import assert from "node:assert/strict";
import {
  resolvePlatformAutopilotGate,
  type PlatformAutopilotClearance,
} from "../src/lib/autopilot/platformClearancePolicy";

const activeClearance: PlatformAutopilotClearance = {
  clearanceId: "11111111-1111-4111-8111-111111111111",
  state: "ACTIVE",
  requestedByUserId: 10,
  approvedByUserId: 11,
  revokedByUserId: null,
  reason: "Bounded production Demo AutoPilot operations window",
  durationMinutes: 60,
  requestedAt: "2026-08-29T10:00:00.000Z",
  approvedAt: "2026-08-29T10:05:00.000Z",
  expiresAt: "2026-08-29T11:05:00.000Z",
  revokedAt: null,
};

assert.deepEqual(
  resolvePlatformAutopilotGate({
    deploymentSuspended: true,
    clearanceRequired: true,
    clearanceAvailable: true,
    clearance: activeClearance,
  }),
  {
    effectiveSuspended: true,
    deploymentSuspended: true,
    clearanceRequired: true,
    reasonCode: "DEPLOYMENT_SUSPENSION_ACTIVE",
    clearance: activeClearance,
  },
  "an approved admin clearance cannot override the deployment hard stop",
);

assert.equal(
  resolvePlatformAutopilotGate({
    deploymentSuspended: false,
    clearanceRequired: true,
    clearanceAvailable: true,
    clearance: null,
  }).reasonCode,
  "ADMIN_CLEARANCE_REQUIRED",
  "production fails closed when no clearance exists",
);

assert.equal(
  resolvePlatformAutopilotGate({
    deploymentSuspended: false,
    clearanceRequired: true,
    clearanceAvailable: true,
    clearance: activeClearance,
  }).effectiveSuspended,
  false,
  "only an active clearance can satisfy the admin gate",
);

assert.equal(
  resolvePlatformAutopilotGate({
    deploymentSuspended: false,
    clearanceRequired: true,
    clearanceAvailable: true,
    clearance: { ...activeClearance, state: "EXPIRED" },
  }).effectiveSuspended,
  true,
  "expired clearance fails closed",
);

assert.equal(
  resolvePlatformAutopilotGate({
    deploymentSuspended: false,
    clearanceRequired: true,
    clearanceAvailable: false,
    clearance: null,
  }).reasonCode,
  "ADMIN_CLEARANCE_UNAVAILABLE",
  "clearance-store failures fail closed",
);

assert.equal(
  resolvePlatformAutopilotGate({
    deploymentSuspended: false,
    clearanceRequired: false,
    clearanceAvailable: false,
    clearance: null,
  }).effectiveSuspended,
  false,
  "non-production behavior remains controlled by the deployment switch",
);

console.log(
  "PASS: platform AutoPilot deployment and admin-clearance gates fail closed",
);

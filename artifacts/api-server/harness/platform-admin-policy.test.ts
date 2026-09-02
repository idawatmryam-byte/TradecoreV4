import assert from "node:assert/strict";
import {
  permissionsForRoles,
  PLATFORM_PERMISSIONS,
  redactPlatformAuditMetadata,
} from "../src/lib/platformAdminPolicy";

assert.deepEqual(
  permissionsForRoles(["PLATFORM_ADMIN"]),
  [...PLATFORM_PERMISSIONS],
  "platform administrators receive only the explicitly enumerated platform permissions",
);
assert.deepEqual(
  permissionsForRoles(["SUPPORT"]),
  ["admin.overview.read", "admin.users.read"],
  "support cannot read execution, risk, audit, configuration, or AI operations",
);
assert.equal(
  permissionsForRoles(["OPERATIONS_RISK"]).includes("admin.users.read"),
  false,
  "operations and risk cannot read user access records",
);
assert.equal(
  permissionsForRoles(["OPERATIONS_RISK"]).includes("admin.risk.suspend"),
  true,
  "operations and risk may immediately reduce AutoPilot authority",
);
assert.equal(
  permissionsForRoles(["OPERATIONS_RISK"]).includes(
    "admin.risk.resume.approve",
  ),
  true,
  "operations and risk may participate in dual-operator Demo AutoPilot resume",
);
assert.equal(
  permissionsForRoles(["OPERATIONS_RISK"]).includes(
    "admin.autopilot.clearance.approve",
  ),
  false,
  "operations and risk may revoke but cannot increase platform AutoPilot authority",
);
assert.equal(
  permissionsForRoles(["OPERATIONS_RISK"]).includes(
    "admin.autopilot.clearance.revoke",
  ),
  true,
  "operations and risk may immediately reduce platform AutoPilot authority",
);
assert.equal(
  permissionsForRoles(["AUDITOR"]).includes(
    "admin.autopilot.clearance.request",
  ),
  false,
  "auditors cannot mutate platform AutoPilot clearance",
);
assert.equal(
  permissionsForRoles(["AUDITOR"]).includes("admin.users.read"),
  false,
  "auditors cannot read user access records",
);
assert.equal(
  permissionsForRoles(["AUDITOR"]).includes("admin.risk.suspend"),
  false,
  "auditors cannot mutate platform AutoPilot safety state",
);

const redacted = redactPlatformAuditMetadata({
  nested: {
    apiKey: "sk-sensitive",
    password: "sensitive-password",
    safe: "visible",
  },
  authorizationHeader: "Bearer sensitive",
  cookies: ["sensitive-cookie"],
  tokenCount: 42,
}) as Record<string, unknown>;
assert.deepEqual(redacted, {
  nested: {
    apiKey: "[REDACTED_SECRET]",
    password: "[REDACTED_SECRET]",
    safe: "visible",
  },
  authorizationHeader: "[REDACTED_SECRET]",
  cookies: "[REDACTED_SECRET]",
  tokenCount: "[REDACTED_SECRET]",
});

console.log(
  "PASS: platform Admin Console permissions and audit redaction are fail-closed",
);

import { chromium } from "@playwright/test";

const baseUrl = process.env.CACTUS_ADMIN_BROWSER_URL ?? "http://127.0.0.1:4174/admin/";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let failures = 0;
let sessionState = "stepup";
let passwordChangeBody = null;
let resumeRequestBody = null;

function expect(name, condition) {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures += 1;
  }
}

const session = () => ({
  eligible: sessionState !== "ineligible",
  roles: sessionState === "ineligible" ? [] : ["PLATFORM_ADMIN"],
  permissions: sessionState === "ineligible" ? [] : ["admin.overview.read", "admin.health.read", "admin.ai.read", "admin.execution.read", "admin.risk.read", "admin.risk.suspend", "admin.risk.resume.request", "admin.risk.resume.approve", "admin.audit.read", "admin.configuration.read"],
  stepUp: sessionState === "active"
    ? { active: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }
    : { active: false, expiresAt: null, reason: "Recent Admin Console step-up is required" },
  mutationsSupported: true,
  mutationReason: "Demo AutoPilot safety changes are guarded and audited.",
});

await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (url.pathname === "/api/admin/session/status") return json(session());
  if (url.pathname === "/api/admin/session/step-up") return json({ ok: true, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  if (url.pathname === "/api/me/account/password") {
    passwordChangeBody = route.request().postDataJSON();
    return json({ ok: true });
  }
  if (url.pathname === "/api/admin/overview") return json({ asOf: new Date().toISOString(), status: "ATTENTION_REQUIRED", counts: { users: 4, configuredSections: 3, desiredRuntimes: 1, unresolvedExecutionIntents: 1, activeSafetySwitches: 1 }, autopilot: { PAUSED: 1 }, authorityBoundary: "Platform visibility does not grant tenant financial authority or broker access." });
  if (url.pathname === "/api/admin/risk/autopilot/resume-requests") {
    resumeRequestBody = route.request().postDataJSON();
    return json({ effectiveSuspended: true });
  }
  if (url.pathname === "/api/admin/risk") return json({
    asOf: new Date().toISOString(),
    activeSwitches: [],
    incidents: [],
    controlsSupported: true,
    controlReason: "Demo AutoPilot resume requires two distinct qualified operators.",
    platformAutopilot: {
      effectiveSuspended: true,
      source: "database",
      reason: "Platform Demo AutoPilot is suspended",
      databaseSuspended: true,
      deploymentHardStop: { active: false, configured: false, malformed: false },
      pendingResume: null,
      asOf: new Date().toISOString(),
    },
  });
  if (url.pathname.startsWith("/api/admin/")) return json({ asOf: new Date().toISOString() });
  return json({ authenticated: true });
});

await page.goto(baseUrl, { waitUntil: "networkidle" });
expect("eligible operator must complete recent step-up", await page.getByRole("heading", { name: "Open the Admin Console" }).isVisible());
expect("step-up copy denies role or financial-authority grant", await page.getByText("it does not grant a platform role or financial authority", { exact: false }).isVisible());
expect("empty password cannot submit step-up", await page.getByRole("button", { name: "Verify and continue" }).isDisabled());

sessionState = "ineligible";
await page.reload({ waitUntil: "networkidle" });
expect("unassigned users receive a server-role denial surface", await page.getByRole("heading", { name: "Platform access is not assigned" }).isVisible());
expect("URL discovery is explicitly not authority", await page.getByText("guessing an `/admin` URL never grants access", { exact: false }).isVisible());

sessionState = "active";
await page.reload({ waitUntil: "networkidle" });
expect("active Admin session opens the operational overview", await page.getByRole("heading", { name: "Overview" }).isVisible());
expect("Admin Console labels mutations as guarded", await page.getByText("Guarded operations", { exact: true }).isVisible());
expect("Admin navigation is separate from trader areas", (await page.locator("nav[aria-label='Admin Console'] a").allTextContents()).every((text) => !["Dashboard", "Strategies", "Backtest Lab", "Settings"].includes(text.trim())));
expect("platform overview repeats financial-authority separation", await page.getByText("does not grant tenant financial authority", { exact: false }).isVisible());

await page.getByRole("link", { name: "Risk & Safety" }).click();
await page.getByLabel("Operator reason").fill("Reviewed Demo AutoPilot recovery after incident resolution");
await page.getByRole("button", { name: "Request Demo AutoPilot resume" }).click();
expect("resume request uses the guarded two-operator endpoint", resumeRequestBody?.confirmation === "REQUEST_PLATFORM_AUTOPILOT_RESUME");

await page.getByRole("link", { name: "Admin Settings" }).click();
expect("assigned administrators can open password settings", await page.getByRole("heading", { name: "Admin Settings" }).isVisible());
await page.getByLabel("Current password").fill("current-password-value");
await page.getByLabel("New password", { exact: true }).fill("new-password-value-123");
await page.getByLabel("Confirm new password", { exact: true }).fill("new-password-value-123");
await page.getByRole("button", { name: "Change password" }).click();
await page.getByText("Password changed.", { exact: false }).waitFor();
expect("Admin password changes use the authenticated account endpoint", passwordChangeBody?.newPassword === "new-password-value-123");
expect("stored passwords are never rendered back into the Admin Console", !(await page.locator("body").innerText()).includes("new-password-value-123"));

await page.setViewportSize({ width: 390, height: 844 });
expect("Admin monitoring view has no document-level horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));

await browser.close();
if (failures > 0) {
  console.error(`FAIL: ${failures} Admin Console browser assertion(s) failed`);
  process.exit(1);
}
console.log("PASS: separate Admin Console access and guarded safety boundaries verified");

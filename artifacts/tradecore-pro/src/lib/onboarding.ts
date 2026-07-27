/**
 * Has this browser finished first-run onboarding?
 *
 * Deliberately localStorage rather than a column on the account. The flag only
 * decides whether to show a wizard that is itself skippable and fully
 * reproducible from Settings, so getting it wrong costs a user one dismissable
 * screen — not worth a schema migration and a round-trip on every load.
 *
 * When storage is unavailable (private mode, blocked cookies) this reports
 * "already onboarded". Failing closed means the wizard never appears in a
 * browser that cannot remember dismissing it, which would otherwise trap the
 * user in it on every visit.
 */
const STORAGE_KEY = "tradecore.onboarding";

export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "done";
  } catch {
    return true;
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "done");
  } catch {
    /* storage unavailable — non-fatal, the wizard simply won't reappear this session */
  }
}

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

/**
 * Social sign-up hand-off.
 *
 * A username/password registration is unmistakable — the app makes the call
 * and sees it succeed. An OAuth round trip is not: Google and Apple return a
 * brand-new account and a five-year-old one through the identical redirect,
 * with the page reloaded and every scrap of in-memory state gone. So the one
 * thing the redirect cannot carry, we park in storage before leaving: the
 * user's own stated intent, taken from whether they were on the Create
 * account tab or the Log in tab when they chose the provider.
 *
 * That is a record of what the person said they were doing, not a guess about
 * it — which is why this is preferable to inferring newness from an account's
 * age. Someone who signs up on the Log in tab is simply never inferred to be
 * new; they configure from Settings, same as before.
 */
const OAUTH_SIGNUP_KEY = "tradecore.oauth-signup";

export function markOAuthSignupIntent(): void {
  try {
    sessionStorage.setItem(OAUTH_SIGNUP_KEY, "1");
  } catch {
    /* storage unavailable — the wizard is skipped, which is the safe direction */
  }
}

/**
 * Reads the intent and clears it in the same breath: it describes one
 * hand-off, so a redirect that never completed (cancelled at the provider,
 * failed callback) must not leave it armed to fire on some later, unrelated
 * login. sessionStorage bounds the damage further — it dies with the tab.
 */
export function consumeOAuthSignupIntent(): boolean {
  try {
    const present = sessionStorage.getItem(OAUTH_SIGNUP_KEY) === "1";
    sessionStorage.removeItem(OAUTH_SIGNUP_KEY);
    return present;
  } catch {
    return false;
  }
}

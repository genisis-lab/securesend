/**
 * install-prefs.ts — persistent, testable rules for WHEN to show the PWA
 * install banner.
 *
 * Goals:
 *   - Don't pester. Respect dismissals across sessions (localStorage, not
 *     sessionStorage), back off after repeated dismissals, and stay quiet for
 *     a cooldown window after each dismissal.
 *   - Don't beg before there's value. Ideally we only nudge AFTER the user has
 *     completed a transfer (handled by the caller passing `hasSucceeded`).
 *
 * All logic here is pure given a `now` and a storage shim, so it's unit-tested
 * without a real browser.
 */

export interface InstallPrefsState {
  /** How many times the user has dismissed the banner. */
  dismissCount: number;
  /** Epoch-ms of the most recent dismissal (0 if never). */
  lastDismissedAt: number;
  /** True once the user has installed (we then never nag again). */
  installed: boolean;
}

const STORAGE_KEY = "securesend:install-prefs:v1";

/** Cooldown after a dismissal before we may show the banner again: 14 days. */
export const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

/** After this many dismissals, stop asking entirely. */
export const MAX_DISMISSALS = 3;

const EMPTY: InstallPrefsState = {
  dismissCount: 0,
  lastDismissedAt: 0,
  installed: false,
};

/** Minimal storage surface so tests can inject an in-memory map. */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadPrefs(storage: PrefsStorage | null): InstallPrefsState {
  if (!storage) return { ...EMPTY };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<InstallPrefsState>;
    return {
      dismissCount:
        typeof parsed.dismissCount === "number" ? parsed.dismissCount : 0,
      lastDismissedAt:
        typeof parsed.lastDismissedAt === "number" ? parsed.lastDismissedAt : 0,
      installed: parsed.installed === true,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function savePrefs(
  storage: PrefsStorage | null,
  state: InstallPrefsState,
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage may be full or blocked (private mode) — non-fatal */
  }
}

export function recordDismissal(
  prev: InstallPrefsState,
  now: number,
): InstallPrefsState {
  return {
    ...prev,
    dismissCount: prev.dismissCount + 1,
    lastDismissedAt: now,
  };
}

export function recordInstalled(prev: InstallPrefsState): InstallPrefsState {
  return { ...prev, installed: true };
}

export interface ShowInput {
  prefs: InstallPrefsState;
  now: number;
  /** Is an install actually possible right now (Chromium prompt or iOS Safari)? */
  canInstall: boolean;
  /** Already running as an installed standalone app? */
  isStandalone: boolean;
  /**
   * Has the user completed at least one successful transfer this session?
   * We prefer to wait for this "earned the right to ask" moment, but it isn't
   * strictly required — see `requireSuccess`.
   */
  hasSucceeded: boolean;
  /**
   * When true, only show after a successful transfer. When false, the banner
   * may show on the home screen too (used as a gentle fallback once the user
   * has spent some time without succeeding).
   */
  requireSuccess: boolean;
}

/**
 * The single decision function: should the install banner be visible now?
 */
export function shouldShowInstall(input: ShowInput): boolean {
  const { prefs, now, canInstall, isStandalone, hasSucceeded, requireSuccess } =
    input;

  if (isStandalone || prefs.installed) return false; // already installed
  if (!canInstall) return false; // nothing to offer on this platform/browser
  if (prefs.dismissCount >= MAX_DISMISSALS) return false; // gave up asking

  // Respect the cooldown window after the most recent dismissal.
  if (
    prefs.lastDismissedAt > 0 &&
    now - prefs.lastDismissedAt < DISMISS_COOLDOWN_MS
  ) {
    return false;
  }

  if (requireSuccess && !hasSucceeded) return false;

  return true;
}

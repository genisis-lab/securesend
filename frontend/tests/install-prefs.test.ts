import { describe, it, expect } from "vitest";
import {
  DISMISS_COOLDOWN_MS,
  MAX_DISMISSALS,
  InstallPrefsState,
  PrefsStorage,
  loadPrefs,
  savePrefs,
  recordDismissal,
  recordInstalled,
  shouldShowInstall,
} from "../src/lib/install-prefs";

function memStorage(seed: Record<string, string> = {}): PrefsStorage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

const base: InstallPrefsState = {
  dismissCount: 0,
  lastDismissedAt: 0,
  installed: false,
};

const baseInput = {
  prefs: base,
  now: 1_000_000_000_000,
  canInstall: true,
  isStandalone: false,
  hasSucceeded: true,
  requireSuccess: true,
};

describe("load/save round-trip", () => {
  it("returns empty defaults when nothing stored", () => {
    expect(loadPrefs(memStorage())).toEqual(base);
  });

  it("persists and reloads state", () => {
    const s = memStorage();
    const next = recordDismissal(base, 123);
    savePrefs(s, next);
    expect(loadPrefs(s)).toEqual(next);
  });

  it("tolerates corrupt JSON", () => {
    expect(loadPrefs(memStorage({ "securesend:install-prefs:v1": "{not json" }))).toEqual(
      base,
    );
  });

  it("is a no-op with null storage", () => {
    expect(loadPrefs(null)).toEqual(base);
    expect(() => savePrefs(null, base)).not.toThrow();
  });
});

describe("recordDismissal / recordInstalled", () => {
  it("increments count and stamps time", () => {
    const next = recordDismissal(base, 555);
    expect(next.dismissCount).toBe(1);
    expect(next.lastDismissedAt).toBe(555);
  });

  it("marks installed", () => {
    expect(recordInstalled(base).installed).toBe(true);
  });
});

describe("shouldShowInstall", () => {
  it("shows when installable, after success, no prior dismissal", () => {
    expect(shouldShowInstall(baseInput)).toBe(true);
  });

  it("hidden when already standalone or installed", () => {
    expect(shouldShowInstall({ ...baseInput, isStandalone: true })).toBe(false);
    expect(
      shouldShowInstall({ ...baseInput, prefs: recordInstalled(base) }),
    ).toBe(false);
  });

  it("hidden when no install path exists", () => {
    expect(shouldShowInstall({ ...baseInput, canInstall: false })).toBe(false);
  });

  it("requires a successful transfer when requireSuccess is true", () => {
    expect(shouldShowInstall({ ...baseInput, hasSucceeded: false })).toBe(false);
  });

  it("can show pre-success when requireSuccess is false", () => {
    expect(
      shouldShowInstall({ ...baseInput, hasSucceeded: false, requireSuccess: false }),
    ).toBe(true);
  });

  it("respects the cooldown window after a dismissal", () => {
    const now = baseInput.now;
    const justDismissed = recordDismissal(base, now - 1000);
    expect(shouldShowInstall({ ...baseInput, prefs: justDismissed })).toBe(false);

    const longAgo = recordDismissal(base, now - DISMISS_COOLDOWN_MS - 1);
    expect(shouldShowInstall({ ...baseInput, prefs: longAgo })).toBe(true);
  });

  it("gives up after MAX_DISMISSALS", () => {
    const maxed: InstallPrefsState = {
      dismissCount: MAX_DISMISSALS,
      lastDismissedAt: 0, // even with no cooldown blocking
      installed: false,
    };
    expect(shouldShowInstall({ ...baseInput, prefs: maxed })).toBe(false);
  });
});

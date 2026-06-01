import { useCallback, useEffect, useMemo, useState } from "react";
import {
  installCapability,
  isIosNonSafari,
  manualGuide,
  ManualGuide,
  readPlatform,
} from "../lib/platform";
import {
  getInstallEventState,
  subscribeInstallEvents,
  triggerInstallPrompt,
} from "../lib/install-events";
import {
  InstallPrefsState,
  loadPrefs,
  recordDismissal,
  recordInstalled,
  savePrefs,
  shouldShowInstall,
} from "../lib/install-prefs";

/** Is the app already running as an installed standalone PWA? */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari exposes this non-standard flag when launched from home screen.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null; // blocked (e.g. some private modes)
  }
}

export interface UseInstallPromptOptions {
  /**
   * Has the user completed at least one successful transfer? Used only as a
   * soft signal now — install UI no longer requires it (see `requireSuccess`).
   */
  hasSucceeded?: boolean;
  /**
   * If true, the auto-banner only appears after a successful transfer.
   * Defaults to FALSE so the app advertises installability up front on every
   * capable browser (the header Install button is always available too).
   */
  requireSuccess?: boolean;
}

/**
 * Decides what install affordance to show, across ALL browsers:
 *
 *   - Chromium (desktop/Android): one-tap install via the captured
 *     `beforeinstallprompt` event. Captured at module load (install-events.ts)
 *     so we never miss Chrome's single early fire. If Chrome hasn't offered a
 *     prompt yet, we fall back to manual instructions (never a dead end).
 *   - iOS Safari / Android Firefox / desktop Safari: no event exists, so we
 *     show platform-specific manual instructions.
 *   - iOS non-Safari: installation needs Safari; we nudge instead of lying.
 *   - Firefox desktop: cannot install a PWA — we show nothing.
 */
export function useInstallPrompt(options: UseInstallPromptOptions = {}) {
  const { hasSucceeded = false, requireSuccess = false } = options;

  // Mirror the module-level install-event singleton into React state.
  const [evtState, setEvtState] = useState(() => getInstallEventState());
  useEffect(
    () => subscribeInstallEvents(() => setEvtState({ ...getInstallEventState() })),
    [],
  );

  const [installed, setInstalled] = useState(isStandalone);
  const [prefs, setPrefs] = useState<InstallPrefsState>(() => loadPrefs(getStorage()));
  // True briefly right after a successful install this session, so the UI can
  // show a "✓ Installed" confirmation (the install button hides simultaneously).
  const [justInstalled, setJustInstalled] = useState(false);
  // When the user explicitly clicks an "Install" button, force the UI open
  // (and the manual steps) even if the auto-banner rules would hide it.
  const [userRequested, setUserRequested] = useState(false);
  // True once the user asked to install but no native prompt was available, so
  // the banner should auto-open its step-by-step instructions.
  const [forceSteps, setForceSteps] = useState(false);

  const platform = useMemo(() => readPlatform(), []);
  const capability = useMemo(() => installCapability(platform), [platform]);
  const guide: ManualGuide = useMemo(() => manualGuide(platform), [platform]);
  const iosNeedsSafari = useMemo(() => isIosNonSafari(platform), [platform]);

  useEffect(() => {
    if (evtState.installed && !installed) {
      setInstalled(true);
      setJustInstalled(true);
      setForceSteps(false);
      setUserRequested(false);
      setPrefs((p) => {
        const next = recordInstalled(p);
        savePrefs(getStorage(), next);
        return next;
      });
    }
  }, [evtState.installed, installed]);

  // Auto-clear the "just installed" confirmation after a few seconds.
  useEffect(() => {
    if (!justInstalled) return;
    const t = setTimeout(() => setJustInstalled(false), 5000);
    return () => clearTimeout(t);
  }, [justInstalled]);

  const promptInstall = useCallback(async () => {
    const outcome = await triggerInstallPrompt();
    if (outcome === null) {
      // No buffered Chromium prompt: fall back to showing manual guidance,
      // and auto-expand the steps so the user isn't left at a dead end.
      setUserRequested(true);
      setForceSteps(true);
    }
  }, []);

  const dismiss = useCallback(() => {
    setUserRequested(false);
    setForceSteps(false);
    setPrefs((p) => {
      const next = recordDismissal(p, Date.now());
      savePrefs(getStorage(), next);
      return next;
    });
  }, []);

  const requestShow = useCallback(() => setUserRequested(true), []);

  // A one-tap Chromium prompt is buffered and ready.
  const canPromptInstall = !!evtState.deferred && !installed;
  // Any real install path exists on this browser (event OR manual steps).
  const canInstall = !installed && capability !== "none";

  const autoVisible = shouldShowInstall({
    prefs,
    now: Date.now(),
    canInstall,
    isStandalone: installed,
    hasSucceeded,
    requireSuccess,
  });

  // Show the banner if auto-rules allow it, OR the user explicitly asked.
  const visible = !installed && canInstall && (autoVisible || userRequested);

  return {
    /** Whether the install banner should render now. */
    visible,
    /** Chromium one-tap install is available right now. */
    canPromptInstall,
    /** This browser can install at all (event or manual). */
    canInstall,
    /** Which manual instruction set applies (if not a one-tap browser). */
    manualGuide: guide,
    /** iOS but not Safari: needs Safari to install. */
    isIosNeedsSafari: iosNeedsSafari && !installed,
    /** When true, the banner should auto-open its step-by-step instructions. */
    autoExpandSteps: forceSteps,
    /** True if the platform genuinely cannot install (e.g. Firefox desktop). */
    cannotInstall: capability === "none" && !iosNeedsSafari,
    installed,
    /** True briefly after install this session (show a "✓ Installed" confirmation). */
    justInstalled,
    promptInstall,
    dismiss,
    /** Force the banner/instructions open (header button). */
    requestShow,
    /** Whether to even offer a header "Install" entry point. */
    showHeaderButton: !installed && (capability !== "none" || iosNeedsSafari),
  };
}

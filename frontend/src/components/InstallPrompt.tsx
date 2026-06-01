import { useEffect, useState } from "react";
import type { ManualGuide } from "../lib/platform";

interface Props {
  /** Whether the banner should be shown at all (visibility rules live in the hook). */
  visible: boolean;
  /** Chromium deferred-prompt install is available (one-tap). */
  canPromptInstall: boolean;
  /** Which manual instruction set applies when one-tap isn't available. */
  manualGuide: ManualGuide;
  /** iOS but not Safari — installation needs Safari. */
  isIosNeedsSafari: boolean;
  /** Auto-open the step-by-step instructions (e.g. user asked, no native prompt). */
  autoExpandSteps?: boolean;
  /** Trigger the Chromium install prompt. */
  onInstall: () => void;
  /** Persist a dismissal (cooldown handled by the hook). */
  onDismiss: () => void;
}

/**
 * PWA install affordance for every browser:
 *   - Chromium/Android: one-tap "Install" button (beforeinstallprompt).
 *   - iOS Safari: "Add to Home Screen" steps.
 *   - Android Firefox: "Install" via the menu.
 *   - Desktop Safari: "Add to Dock" via File / Share.
 *   - iOS non-Safari: nudge to reopen in Safari.
 *
 * Visibility, dismissal, and cooldown are decided by `useInstallPrompt`; this
 * component is purely presentational.
 */
export function InstallPrompt({
  visible,
  canPromptInstall,
  manualGuide,
  isIosNeedsSafari,
  autoExpandSteps,
  onInstall,
  onDismiss,
}: Props) {
  const [showSteps, setShowSteps] = useState(false);

  // When the user asked to install but there's no native prompt, open the steps.
  useEffect(() => {
    if (autoExpandSteps) setShowSteps(true);
  }, [autoExpandSteps]);

  if (!visible) return null;

  const headline = isIosNeedsSafari
    ? "📲 Want SecureSend on your home screen? Open this page in Safari to install it."
    : "📲 Install SecureSend for quick, full-screen access — it works like a native app.";

  return (
    <div className="install-banner install-banner--column" role="region" aria-label="Install SecureSend">
      <div className="install-banner__row">
        <span>{headline}</span>
        <div className="row u-gap-8">
          {canPromptInstall ? (
            <button className="btn" onClick={onInstall}>
              Install
            </button>
          ) : manualGuide ? (
            <button className="btn" onClick={() => setShowSteps((v) => !v)}>
              How to install
            </button>
          ) : null}
          <button className="btn btn--ghost" onClick={onDismiss} aria-label="Dismiss">
            ✕
          </button>
        </div>
      </div>

      {showSteps && manualGuide && (
        <InstallSteps guide={manualGuide} />
      )}
    </div>
  );
}

function InstallSteps({ guide }: { guide: NonNullable<ManualGuide> }) {
  if (guide === "ios-safari") {
    return (
      <ol className="install-steps">
        <li>
          Tap the <strong>Share</strong> button <span aria-hidden>⬆️</span> in
          Safari's toolbar.
        </li>
        <li>
          Scroll down and tap <strong>Add to Home Screen</strong>.
        </li>
        <li>
          Tap <strong>Add</strong> — SecureSend appears on your home screen.
        </li>
      </ol>
    );
  }
  if (guide === "android-firefox") {
    return (
      <ol className="install-steps">
        <li>
          Tap the <strong>⋮ menu</strong> in Firefox's toolbar.
        </li>
        <li>
          Tap <strong>Install</strong> (or <strong>Add to Home screen</strong>).
        </li>
        <li>
          Confirm — SecureSend appears on your home screen.
        </li>
      </ol>
    );
  }
  if (guide === "chromium-android") {
    return (
      <ol className="install-steps">
        <li>
          Tap the <strong>⋮ menu</strong> in your browser's toolbar.
        </li>
        <li>
          Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>).
        </li>
        <li>
          Confirm — SecureSend appears on your home screen.
        </li>
      </ol>
    );
  }
  if (guide === "chromium-desktop") {
    return (
      <ol className="install-steps">
        <li>
          Look for the <strong>install icon</strong>{" "}
          <span aria-hidden>⊕</span> at the right edge of the address bar (or
          open the <strong>⋮ menu</strong>).
        </li>
        <li>
          Click it and choose <strong>Install</strong> (look for{" "}
          <strong>Cast, save, and share</strong> →{" "}
          <strong>Install page as app…</strong> in newer Chrome).
        </li>
        <li>
          Confirm — SecureSend opens in its own window.
        </li>
      </ol>
    );
  }
  // desktop-safari
  return (
    <ol className="install-steps">
      <li>
        In Safari, open the <strong>File</strong> menu (or the{" "}
        <strong>Share</strong> button).
      </li>
      <li>
        Choose <strong>Add to Dock…</strong>.
      </li>
      <li>
        Click <strong>Add</strong> — SecureSend opens in its own window.
      </li>
    </ol>
  );
}

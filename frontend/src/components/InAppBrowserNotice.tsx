import { useMemo, useState } from "react";
import {
  androidIntentUrl,
  getInAppBrowserName,
  isAndroid,
  isIosDevice,
  readPlatform,
} from "../lib/platform";

/**
 * InAppBrowserNotice — shown on a RECEIVE link when the page is running inside
 * an in-app browser (Discord, Instagram, Messenger, TikTok, …).
 *
 * Those embedded WebViews routinely block WebRTC (so live P2P may never
 * connect), expose no File System Access API (so streaming-to-disk and large
 * files fail), and have no PWA install. The reliable fix is to reopen the link
 * in the user's REAL browser. We make that one tap:
 *
 *   - Copy link: copies the full URL *including the secret #fragment* so the
 *     key survives the hop. The user pastes it into their browser.
 *   - Open in browser: on Android we can hand off via an `intent://` URL; iOS
 *     has no programmatic escape, so we show the "tap ••• → Open in Safari"
 *     hint instead.
 *
 * Nothing here consumes the transfer — copying/reopening is always safe because
 * reads are idempotent and burn only fires after a confirmed save.
 */
export function InAppBrowserNotice() {
  const platform = useMemo(() => readPlatform(), []);
  const appName = useMemo(() => getInAppBrowserName(platform), [platform]);
  const fullUrl =
    typeof window !== "undefined" ? window.location.href : "";
  const intentUrl = useMemo(
    () => androidIntentUrl(platform, fullUrl),
    [platform, fullUrl],
  );

  const [copied, setCopied] = useState(false);
  const [showManual, setShowManual] = useState(false);

  if (!appName) return null;

  const label = appName === "in-app" ? "this app's built-in browser" : `${appName}'s built-in browser`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (common in webviews): reveal the URL to copy by hand.
      setShowManual(true);
    }
  };

  const openInBrowser = () => {
    if (intentUrl) {
      // Android: hand off to the default browser via an intent URL.
      window.location.href = intentUrl;
    } else {
      // iOS / unknown: we can't force it — show the manual steps.
      setShowManual(true);
    }
  };

  return (
    <div className="inapp-notice" role="alert">
      <div className="inapp-notice__head">
        <span aria-hidden>⚠️</span>
        <strong>You're in {label}</strong>
      </div>
      <p className="inapp-notice__body">
        It can block secure transfers (encrypted P2P, large files, and saving to
        your device). For this to work reliably, open this link in your real
        browser — your link still works, nothing is used up.
      </p>

      <div className="inapp-notice__actions">
        <button className="btn" onClick={copy}>
          {copied ? "✓ Link copied" : "Copy link"}
        </button>
        <button className="btn btn--ghost" onClick={openInBrowser}>
          Open in browser
        </button>
      </div>

      {(showManual || (!intentUrl && isIosDevice(platform))) && (
        <div className="inapp-notice__manual">
          {isIosDevice(platform) ? (
            <ol className="install-steps">
              <li>Tap <strong>Copy link</strong> above (or the ⋯ / share icon).</li>
              <li>
                Open <strong>Safari</strong>, tap the address bar, and{" "}
                <strong>paste</strong> the link.
              </li>
              <li>Press <strong>Go</strong> — the transfer continues there.</li>
            </ol>
          ) : isAndroid(platform) ? (
            <ol className="install-steps">
              <li>Tap the <strong>⋮ menu</strong> in the corner.</li>
              <li>Choose <strong>Open in browser</strong> (or <strong>Open in Chrome</strong>).</li>
              <li>If that's missing, tap <strong>Copy link</strong> and paste it into Chrome.</li>
            </ol>
          ) : (
            <p className="card__hint">
              Copy the link and paste it into a standalone browser like Chrome,
              Safari, Edge, or Firefox.
            </p>
          )}
          {showManual && (
            <input
              className="input u-mt-8"
              readOnly
              value={fullUrl}
              aria-label="Transfer link"
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </div>
      )}
    </div>
  );
}

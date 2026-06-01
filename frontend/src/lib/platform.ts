/**
 * platform.ts — small, pure platform-detection helpers for install UX.
 *
 * Kept framework-free and side-effect-free so they can be unit-tested with
 * synthetic user-agent strings. The hook layer (`useInstallPrompt`) feeds in
 * the real `navigator` values.
 */

export interface PlatformInfo {
  /** navigator.userAgent */
  ua: string;
  /** navigator.maxTouchPoints (0 if unknown) */
  maxTouchPoints: number;
  /** Whether the document exposes touch events ("ontouchend" in document). */
  hasTouch: boolean;
}

/** Read platform info from the live environment (browser only). */
export function readPlatform(): PlatformInfo {
  if (typeof navigator === "undefined") {
    return { ua: "", maxTouchPoints: 0, hasTouch: false };
  }
  return {
    ua: navigator.userAgent || "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    hasTouch:
      typeof document !== "undefined" && "ontouchend" in document,
  };
}

/**
 * Is this an iOS / iPadOS device?
 *
 * iPadOS 13+ masquerades as desktop Safari ("Macintosh" UA), so we additionally
 * require touch support. We deliberately avoid the deprecated, unreliable
 * `navigator.platform === "MacIntel"` check that the old code used.
 */
export function isIosDevice(p: PlatformInfo): boolean {
  const iPhoneIPod = /iPad|iPhone|iPod/.test(p.ua);
  const iPadOnDesktopUa =
    /Macintosh/.test(p.ua) && p.hasTouch && p.maxTouchPoints > 1;
  return iPhoneIPod || iPadOnDesktopUa;
}

/**
 * On iOS, ONLY Safari can add a real PWA to the home screen. Every other iOS
 * browser (Chrome/CriOS, Firefox/FxiOS, Edge/EdgiOS, Opera, DuckDuckGo, the
 * Google app/GSA, in-app webviews) is WebKit underneath but cannot install a
 * standalone PWA — so showing "Add to Home Screen" steps there is misleading.
 */
export function isIosSafari(p: PlatformInfo): boolean {
  if (!isIosDevice(p)) return false;
  // Any in-app browser (Discord, Instagram, TikTok, …) can't install — keep
  // this in sync with getInAppBrowserName so we never show install steps there.
  if (isInAppBrowser(p)) return false;
  const nonSafari = /CriOS|FxiOS|EdgiOS|OPiOS|GSA|DuckDuckGo|mercury|FBAN|FBAV|Instagram|Line\//i.test(
    p.ua,
  );
  return !nonSafari;
}

/**
 * An iOS browser that is NOT Safari. Useful to nudge the user to reopen the
 * link in Safari, where installation is actually possible.
 */
export function isIosNonSafari(p: PlatformInfo): boolean {
  return isIosDevice(p) && !isIosSafari(p);
}

/** Is this Android (any browser)? */
export function isAndroid(p: PlatformInfo): boolean {
  return /Android/.test(p.ua);
}

/** Firefox (desktop or Android). */
export function isFirefox(p: PlatformInfo): boolean {
  return /Firefox\/|FxiOS/.test(p.ua);
}

/** Chromium-family on desktop/Android (Chrome, Edge, Brave, Opera, Samsung). */
export function isChromium(p: PlatformInfo): boolean {
  // Exclude iOS, where every browser is WebKit and lacks beforeinstallprompt.
  if (isIosDevice(p)) return false;
  return /Chrome\/|Chromium\/|CriOS|Edg\/|EdgA\/|OPR\/|SamsungBrowser/.test(p.ua);
}

/** Desktop Safari (macOS), which supports "Add to Dock" but fires no event. */
export function isDesktopSafari(p: PlatformInfo): boolean {
  if (isIosDevice(p)) return false;
  const isMac = /Macintosh/.test(p.ua);
  const isSafari = /Safari\//.test(p.ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\//.test(p.ua);
  return isMac && isSafari;
}

/**
 * Known in-app browser (embedded WebView) signatures.
 *
 * When a link is opened from inside a native app (Discord, Instagram, Messenger,
 * TikTok, etc.) it loads in that app's embedded WebView — NOT the user's real
 * browser. Those webviews routinely block or break WebRTC, expose no PWA install
 * or File System Access API, and handle downloads awkwardly. We detect them so
 * we can nudge the user to reopen the link in their real browser.
 *
 * Each entry maps a human-readable name to a UA regex. Order matters only for
 * the returned name (first match wins).
 */
const IN_APP_BROWSERS: { name: string; re: RegExp }[] = [
  { name: "Discord", re: /Discord/i },
  { name: "Instagram", re: /Instagram/i },
  { name: "Facebook", re: /\bFBAN\b|\bFBAV\b|\bFB_IAB\b|FB4A|FBIOS/i },
  { name: "Messenger", re: /Messenger/i },
  { name: "TikTok", re: /\bBytedanceWebview\b|musical_ly|\bTikTok\b|trill\//i },
  { name: "Snapchat", re: /Snapchat/i },
  { name: "LinkedIn", re: /\bLinkedInApp\b/i },
  { name: "Twitter", re: /\bTwitter\b/i },
  { name: "Line", re: /\bLine\//i },
  { name: "WeChat", re: /MicroMessenger/i },
  { name: "Telegram", re: /\bTelegram\b/i },
  { name: "Pinterest", re: /\bPinterest\b/i },
  { name: "Slack", re: /\bSlack\b/i },
  { name: "KakaoTalk", re: /KAKAOTALK/i },
];

/**
 * The name of the in-app browser this page is running inside, or null if it
 * looks like a normal standalone browser.
 */
export function getInAppBrowserName(p: PlatformInfo): string | null {
  for (const b of IN_APP_BROWSERS) {
    if (b.re.test(p.ua)) return b.name;
  }
  // Heuristic for generic Android WebViews (in-app browsers that don't brand
  // their UA): Android + the "; wv" WebView token, which Chrome proper omits.
  if (isAndroid(p) && /;\s*wv\b/.test(p.ua)) return "in-app";
  return null;
}

/** Is this page running inside a known in-app browser / embedded WebView? */
export function isInAppBrowser(p: PlatformInfo): boolean {
  return getInAppBrowserName(p) !== null;
}

/**
 * Build an Android `intent://` URL that asks Android to open `httpsUrl` in the
 * user's default browser (with a Chrome fallback). Only meaningful on Android;
 * returns null elsewhere. iOS has no equivalent programmatic escape — the user
 * must use the in-app browser's "Open in Safari/Browser" menu item.
 *
 * The original URL (including its secret #fragment) is preserved so the
 * receive flow still has the key after the hop.
 */
export function androidIntentUrl(p: PlatformInfo, httpsUrl: string): string | null {
  if (!isAndroid(p)) return null;
  let parsed: URL;
  try {
    parsed = new URL(httpsUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  // intent://host/path?query#Intent;scheme=https;...;end  — the URL fragment
  // (the key) is appended after the Intent block so the browser receives it.
  const fragment = parsed.hash; // includes leading '#', may be ""
  const withoutFragment = httpsUrl.slice(0, httpsUrl.length - fragment.length);
  const afterScheme = withoutFragment.replace(/^https:\/\//, "");
  const intent =
    `intent://${afterScheme}#Intent;scheme=https;` +
    `action=android.intent.action.VIEW;` +
    `S.browser_fallback_url=${encodeURIComponent(httpsUrl)};end`;
  // Re-attach the secret fragment so the destination browser still gets the key.
  return fragment ? intent + fragment : intent;
}

/**
 * How can THIS browser install a PWA?
 *
 *   "event"  — Chromium fires beforeinstallprompt; we can offer one-tap install.
 *   "manual" — installable, but no prompt event: show step-by-step instructions
 *              (iOS Safari, Android Firefox, desktop Safari "Add to Dock").
 *   "none"   — cannot install a PWA at all (Firefox on desktop).
 *
 * Note: even on Chromium we may not have a *buffered* event yet (engagement
 * heuristics, or it already fired-and-was-used). The hook combines this with
 * the live event state to decide what UI to show.
 */
export type InstallCapability = "event" | "manual" | "none";

export function installCapability(p: PlatformInfo): InstallCapability {
  if (isIosDevice(p)) {
    return isIosSafari(p) ? "manual" : "none"; // iOS non-Safari can't install
  }
  if (isChromium(p)) return "event";
  if (isAndroid(p) && isFirefox(p)) return "manual"; // Firefox Android can install
  if (isFirefox(p)) return "none"; // Firefox desktop cannot install PWAs
  if (isDesktopSafari(p)) return "manual"; // Safari 17+ "Add to Dock"
  return "none";
}

/** Which manual-instruction set to show for a non-event installable browser. */
export type ManualGuide =
  | "ios-safari"
  | "android-firefox"
  | "desktop-safari"
  | "chromium-desktop"
  | "chromium-android"
  | null;

/**
 * The manual instructions to show when a one-tap prompt isn't available.
 *
 * Chromium is included as a FALLBACK: Chrome only fires `beforeinstallprompt`
 * after its own engagement heuristics are met (and suppresses it for ~90 days
 * after a dismissal, or entirely once installed). When the user explicitly asks
 * to install but no prompt is buffered, we must still tell them how — via the
 * address-bar install icon (desktop) or the ⋮ menu (Android).
 */
export function manualGuide(p: PlatformInfo): ManualGuide {
  if (isIosSafari(p)) return "ios-safari";
  if (isAndroid(p) && isFirefox(p)) return "android-firefox";
  if (isDesktopSafari(p)) return "desktop-safari";
  if (isChromium(p)) return isAndroid(p) ? "chromium-android" : "chromium-desktop";
  return null;
}

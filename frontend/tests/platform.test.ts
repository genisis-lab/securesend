import { describe, it, expect } from "vitest";
import {
  isIosDevice,
  isIosSafari,
  isIosNonSafari,
  isAndroid,
  isFirefox,
  isChromium,
  isDesktopSafari,
  installCapability,
  manualGuide,
  getInAppBrowserName,
  isInAppBrowser,
  androidIntentUrl,
  PlatformInfo,
} from "../src/lib/platform";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1";
const IPHONE_FIREFOX =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const WIN_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0";
const FIREFOX_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36";
const ANDROID_FIREFOX =
  "Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0";

const p = (ua: string, maxTouchPoints = 0, hasTouch = false): PlatformInfo => ({
  ua,
  maxTouchPoints,
  hasTouch,
});

describe("isIosDevice", () => {
  it("detects iPhone regardless of browser", () => {
    expect(isIosDevice(p(IPHONE_SAFARI))).toBe(true);
    expect(isIosDevice(p(IPHONE_CHROME))).toBe(true);
  });

  it("detects iPadOS reporting a desktop Mac UA via touch", () => {
    expect(isIosDevice(p(IPAD_SAFARI_DESKTOP_UA, 5, true))).toBe(true);
  });

  it("does NOT treat a real Mac (no touch) as iOS", () => {
    expect(isIosDevice(p(MAC_SAFARI, 0, false))).toBe(false);
  });

  it("does not treat Android as iOS", () => {
    expect(isIosDevice(p(ANDROID_CHROME, 5, true))).toBe(false);
  });
});

describe("isIosSafari", () => {
  it("true for iPhone Safari", () => {
    expect(isIosSafari(p(IPHONE_SAFARI))).toBe(true);
  });

  it("true for iPadOS Safari (desktop UA + touch)", () => {
    expect(isIosSafari(p(IPAD_SAFARI_DESKTOP_UA, 5, true))).toBe(true);
  });

  it("false for iOS Chrome and iOS Firefox (cannot install PWA)", () => {
    expect(isIosSafari(p(IPHONE_CHROME))).toBe(false);
    expect(isIosSafari(p(IPHONE_FIREFOX))).toBe(false);
  });

  it("false for non-iOS platforms", () => {
    expect(isIosSafari(p(ANDROID_CHROME, 5, true))).toBe(false);
    expect(isIosSafari(p(MAC_SAFARI, 0, false))).toBe(false);
  });
});

describe("isIosNonSafari", () => {
  it("true only for iOS browsers that are not Safari", () => {
    expect(isIosNonSafari(p(IPHONE_CHROME))).toBe(true);
    expect(isIosNonSafari(p(IPHONE_FIREFOX))).toBe(true);
    expect(isIosNonSafari(p(IPHONE_SAFARI))).toBe(false);
    expect(isIosNonSafari(p(ANDROID_CHROME, 5, true))).toBe(false);
  });
});

describe("browser-family detectors", () => {
  it("isAndroid", () => {
    expect(isAndroid(p(ANDROID_CHROME, 5, true))).toBe(true);
    expect(isAndroid(p(ANDROID_FIREFOX, 5, true))).toBe(true);
    expect(isAndroid(p(WIN_EDGE))).toBe(false);
  });

  it("isFirefox", () => {
    expect(isFirefox(p(FIREFOX_DESKTOP))).toBe(true);
    expect(isFirefox(p(ANDROID_FIREFOX, 5, true))).toBe(true);
    expect(isFirefox(p(IPHONE_FIREFOX))).toBe(true);
    expect(isFirefox(p(MAC_CHROME))).toBe(false);
  });

  it("isChromium excludes iOS and Firefox", () => {
    expect(isChromium(p(MAC_CHROME))).toBe(true);
    expect(isChromium(p(WIN_EDGE))).toBe(true);
    expect(isChromium(p(ANDROID_CHROME, 5, true))).toBe(true);
    expect(isChromium(p(IPHONE_CHROME))).toBe(false); // iOS = WebKit
    expect(isChromium(p(FIREFOX_DESKTOP))).toBe(false);
  });

  it("isDesktopSafari only matches Mac Safari (not Chrome/iOS)", () => {
    expect(isDesktopSafari(p(MAC_SAFARI))).toBe(true);
    expect(isDesktopSafari(p(MAC_CHROME))).toBe(false);
    expect(isDesktopSafari(p(IPAD_SAFARI_DESKTOP_UA, 5, true))).toBe(false); // iPad => iOS
  });
});

describe("installCapability", () => {
  it("event for Chromium desktop/Android", () => {
    expect(installCapability(p(MAC_CHROME))).toBe("event");
    expect(installCapability(p(WIN_EDGE))).toBe("event");
    expect(installCapability(p(ANDROID_CHROME, 5, true))).toBe("event");
  });

  it("manual for iOS Safari, Android Firefox, desktop Safari", () => {
    expect(installCapability(p(IPHONE_SAFARI))).toBe("manual");
    expect(installCapability(p(ANDROID_FIREFOX, 5, true))).toBe("manual");
    expect(installCapability(p(MAC_SAFARI))).toBe("manual");
  });

  it("none for iOS non-Safari and desktop Firefox", () => {
    expect(installCapability(p(IPHONE_CHROME))).toBe("none");
    expect(installCapability(p(IPHONE_FIREFOX))).toBe("none");
    expect(installCapability(p(FIREFOX_DESKTOP))).toBe("none");
  });
});

describe("manualGuide", () => {
  it("maps each manual platform to its guide", () => {
    expect(manualGuide(p(IPHONE_SAFARI))).toBe("ios-safari");
    expect(manualGuide(p(ANDROID_FIREFOX, 5, true))).toBe("android-firefox");
    expect(manualGuide(p(MAC_SAFARI))).toBe("desktop-safari");
  });

  it("falls back to chromium guides (so the Install button is never a dead end)", () => {
    expect(manualGuide(p(MAC_CHROME))).toBe("chromium-desktop");
    expect(manualGuide(p(WIN_EDGE))).toBe("chromium-desktop");
    expect(manualGuide(p(ANDROID_CHROME, 5, true))).toBe("chromium-android");
  });

  it("returns null only where installation is truly impossible", () => {
    expect(manualGuide(p(FIREFOX_DESKTOP))).toBeNull();
    expect(manualGuide(p(IPHONE_CHROME))).toBeNull(); // needs Safari instead
  });
});

const DISCORD_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Discord/200.0";
const INSTAGRAM_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36 Instagram 300.0.0.0 Android";
const FB_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]";
const TIKTOK_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 BytedanceWebview/d8a21c trill_2023";
const GENERIC_ANDROID_WV =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/123.0.0.0 Mobile Safari/537.36";

describe("in-app browser detection", () => {
  it("names known in-app browsers", () => {
    expect(getInAppBrowserName(p(DISCORD_IOS))).toBe("Discord");
    expect(getInAppBrowserName(p(INSTAGRAM_ANDROID, 5, true))).toBe("Instagram");
    expect(getInAppBrowserName(p(FB_IOS))).toBe("Facebook");
    expect(getInAppBrowserName(p(TIKTOK_ANDROID, 5, true))).toBe("TikTok");
  });

  it("flags generic Android WebViews via the ;wv token", () => {
    expect(getInAppBrowserName(p(GENERIC_ANDROID_WV, 5, true))).toBe("in-app");
    expect(isInAppBrowser(p(GENERIC_ANDROID_WV, 5, true))).toBe(true);
  });

  it("does NOT flag real standalone browsers", () => {
    expect(isInAppBrowser(p(IPHONE_SAFARI))).toBe(false);
    expect(isInAppBrowser(p(ANDROID_CHROME, 5, true))).toBe(false);
    expect(isInAppBrowser(p(MAC_CHROME))).toBe(false);
    expect(isInAppBrowser(p(WIN_EDGE))).toBe(false);
    expect(isInAppBrowser(p(FIREFOX_DESKTOP))).toBe(false);
  });
});

describe("androidIntentUrl", () => {
  const url = "https://example.pages.dev/#/r/ROOM123/k/SECRETKEY";

  it("builds an intent URL on Android, preserving the secret fragment", () => {
    const intent = androidIntentUrl(p(INSTAGRAM_ANDROID, 5, true), url);
    expect(intent).toBeTruthy();
    expect(intent!.startsWith("intent://example.pages.dev/")).toBe(true);
    expect(intent!).toContain("scheme=https");
    expect(intent!).toContain("S.browser_fallback_url=");
    // The key fragment must survive the hop to the real browser.
    expect(intent!.endsWith("#/r/ROOM123/k/SECRETKEY")).toBe(true);
  });

  it("returns null on non-Android (no programmatic escape on iOS)", () => {
    expect(androidIntentUrl(p(DISCORD_IOS), url)).toBeNull();
    expect(androidIntentUrl(p(MAC_CHROME), url)).toBeNull();
  });

  it("returns null for non-https URLs", () => {
    expect(androidIntentUrl(p(INSTAGRAM_ANDROID, 5, true), "http://x.test/")).toBeNull();
  });
});

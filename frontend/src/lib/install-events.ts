/**
 * install-events.ts — capture the Chromium `beforeinstallprompt` event as
 * early as possible.
 *
 * WHY a module-level singleton instead of a React effect:
 *   Chrome fires `beforeinstallprompt` exactly once, very early in page life.
 *   If we only attach the listener after React mounts, we can miss it entirely
 *   (this is the #1 reason a perfectly-installable app shows no install UI on
 *   Chrome). Importing this module at the top of the entry file registers the
 *   listener before any rendering, so the event is buffered and replayable.
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface InstallEventState {
  /** The most recent deferred prompt event, if Chromium offered one. */
  deferred: BeforeInstallPromptEvent | null;
  /** True once the app has been installed (appinstalled fired). */
  installed: boolean;
}

const state: InstallEventState = { deferred: null, installed: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

// Register listeners immediately at import time (browser only).
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e: Event) => {
    // Prevent the mini-infobar so we can present our own UI on our schedule.
    e.preventDefault();
    state.deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    state.installed = true;
    state.deferred = null;
    emit();
  });
}

/** Current snapshot of the captured install-event state. */
export function getInstallEventState(): InstallEventState {
  return state;
}

/** Subscribe to install-event changes; returns an unsubscribe fn. */
export function subscribeInstallEvents(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Trigger the captured Chromium install prompt, if one is buffered.
 * Returns the user's choice, or null if no prompt was available.
 */
export async function triggerInstallPrompt(): Promise<
  "accepted" | "dismissed" | null
> {
  const evt = state.deferred;
  if (!evt) return null;
  await evt.prompt();
  const choice = await evt.userChoice;
  // A deferred prompt can only be used once.
  state.deferred = null;
  emit();
  return choice.outcome;
}

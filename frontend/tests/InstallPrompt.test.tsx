import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { InstallPrompt } from "../src/components/InstallPrompt";

// Lightweight component tests using react-dom/client against jsdom — no extra
// testing-library dependency. We render into a detached container and assert on
// the produced DOM, and drive clicks via native events wrapped in act().

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

function click(el: Element | null) {
  if (!el) throw new Error("element to click not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const baseProps = {
  visible: true,
  canPromptInstall: false,
  manualGuide: null as null | "ios-safari" | "chromium-desktop",
  isIosNeedsSafari: false,
  onInstall: () => {},
  onDismiss: () => {},
};

describe("<InstallPrompt>", () => {
  it("renders nothing when not visible", () => {
    render(<InstallPrompt {...baseProps} visible={false} />);
    expect(container.querySelector(".install-banner")).toBeNull();
  });

  it("shows a one-tap Install button when canPromptInstall is true", () => {
    const onInstall = vi.fn();
    render(
      <InstallPrompt {...baseProps} canPromptInstall onInstall={onInstall} />,
    );
    const btn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Install",
    );
    expect(btn).toBeTruthy();
    click(btn!);
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it("shows a 'How to install' toggle (not Install) when only a manual guide exists", () => {
    render(<InstallPrompt {...baseProps} manualGuide="chromium-desktop" />);
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("How to install");
    expect(labels).not.toContain("Install");
    // Steps hidden until toggled.
    expect(container.querySelector(".install-steps")).toBeNull();
  });

  it("auto-expands steps when autoExpandSteps is set (the dead-end fix)", () => {
    render(
      <InstallPrompt {...baseProps} manualGuide="chromium-desktop" autoExpandSteps />,
    );
    expect(container.querySelector(".install-steps")).not.toBeNull();
  });

  it("nudges iOS non-Safari users toward Safari with no dead-end button", () => {
    render(<InstallPrompt {...baseProps} isIosNeedsSafari manualGuide={null} />);
    expect(container.textContent).toMatch(/open this page in safari/i);
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("Install");
    expect(labels).not.toContain("How to install");
  });

  it("calls onDismiss when the ✕ is clicked", () => {
    const onDismiss = vi.fn();
    render(<InstallPrompt {...baseProps} manualGuide="ios-safari" onDismiss={onDismiss} />);
    const dismiss = container.querySelector('button[aria-label="Dismiss"]');
    click(dismiss);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

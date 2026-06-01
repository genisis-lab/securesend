import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Hero } from "../src/components/Hero";

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
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function buttonLabels(): string[] {
  return [...container.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
}

describe("<Hero>", () => {
  it("shows the headline only on the home view", () => {
    render(<Hero onHome={() => {}} isHome />);
    expect(container.querySelector(".hero__headline")).not.toBeNull();

    render(<Hero onHome={() => {}} isHome={false} />);
    expect(container.querySelector(".hero__headline")).toBeNull();
  });

  it("shows a Home button only when off the home view", () => {
    render(<Hero onHome={() => {}} isHome={false} />);
    expect(buttonLabels().some((l) => /home/i.test(l))).toBe(true);

    render(<Hero onHome={() => {}} isHome />);
    expect(buttonLabels().some((l) => /home/i.test(l))).toBe(false);
  });

  it("shows the Install button when showInstall is set, and fires onInstall", () => {
    const onInstall = vi.fn();
    render(<Hero onHome={() => {}} isHome showInstall onInstall={onInstall} />);
    const installBtn = container.querySelector('button[aria-label="Install SecureSend app"]');
    expect(installBtn).not.toBeNull();
    click(installBtn);
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it("shows the '✓ Installed' confirmation instead of the button after install", () => {
    render(
      <Hero onHome={() => {}} isHome showInstall justInstalled onInstall={() => {}} />,
    );
    expect(container.querySelector(".installed-badge")).not.toBeNull();
    expect(container.querySelector('button[aria-label="Install SecureSend app"]')).toBeNull();
  });

  it("clicking the brand navigates home", () => {
    const onHome = vi.fn();
    render(<Hero onHome={onHome} isHome />);
    click(container.querySelector('button[aria-label="SecureSend home"]'));
    expect(onHome).toHaveBeenCalledOnce();
  });
});

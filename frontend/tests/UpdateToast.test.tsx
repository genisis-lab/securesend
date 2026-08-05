import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { UpdateToast } from "../src/components/UpdateToast";

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

function render(needRefresh: boolean, onUpdate = () => {}, onDismiss = () => {}) {
  act(() => root.render(
    <UpdateToast
      needRefresh={needRefresh}
      onUpdate={onUpdate}
      onDismiss={onDismiss}
    />,
  ));
}

function click(el: Element | null) {
  if (!el) throw new Error("element to click not found");
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("<UpdateToast>", () => {
  it("stays hidden when no update is waiting", () => {
    render(false);
    expect(container.querySelector(".toast")).toBeNull();
    expect(container.textContent).not.toMatch(/ready to work offline/i);
  });

  it("shows the manual reload prompt when an update is waiting", () => {
    render(true);
    expect(container.textContent).toMatch(/new version of SecureSend/i);
    expect(container.textContent).not.toMatch(/ready to work offline/i);
  });

  it("keeps the reload and dismiss actions working", () => {
    const onUpdate = vi.fn();
    const onDismiss = vi.fn();
    render(true, onUpdate, onDismiss);

    click([...container.querySelectorAll("button")].find((button) => button.textContent === "Reload") ?? null);
    click(container.querySelector('button[aria-label="Dismiss"]'));

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

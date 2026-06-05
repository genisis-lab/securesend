import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PasteLink } from "../src/components/PasteLink";

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

function change(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: Element | null) {
  if (!el) throw new Error("element to click not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("<PasteLink>", () => {
  it("warns when an invite link is missing its secret key fragment", () => {
    const onOpen = vi.fn();
    render(<PasteLink onOpen={onOpen} />);

    change(
      container.querySelector<HTMLInputElement>('input[aria-label="Invite link"]')!,
      "https://securesend.pages.dev/#/r/room-without-key",
    );
    click(container.querySelector("button"));

    expect(onOpen).not.toHaveBeenCalled();
    expect(container.textContent).toContain("missing its secret key");
  });
});

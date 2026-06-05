import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SenderPanel } from "../src/components/SenderPanel";

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

function change(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("<SenderPanel>", () => {
  it("lets senders rename, reorder, and include a note with multiple files", () => {
    const onStart = vi.fn();
    render(
      <SenderPanel
        state={null}
        onStart={onStart}
        onCancel={() => {}}
        onReset={() => {}}
        initialFiles={[
          new File(["a"], "a.txt", { type: "text/plain" }),
          new File(["b"], "b.txt", { type: "text/plain" }),
        ]}
      />,
    );

    expect(container.textContent).toContain("2 items");
    expect(container.textContent).toContain("Move down");
    expect(container.textContent).toContain("Optional message");
    expect(container.textContent).toContain("What can the server see?");

    const renameInputs = [...container.querySelectorAll<HTMLInputElement>('input[aria-label^="Rename"]')];
    change(renameInputs[0], "renamed-a.txt");
    const moveDown = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Move down",
    );
    click(moveDown ?? null);

    const note = container.querySelector<HTMLTextAreaElement>("#file-note");
    change(note!, "please review these");

    const create = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Create secure invite"),
    );
    click(create ?? null);

    expect(onStart).toHaveBeenCalledOnce();
    const sent = onStart.mock.calls[0][0] as File[];
    expect(sent.map((file) => file.name)).toEqual([
      "b.txt",
      "renamed-a.txt",
      expect.stringMatching(/^securesend-message-/),
    ]);
  });

  it("surfaces passphrase strength and can generate a memorable passphrase", () => {
    render(
      <SenderPanel
        state={null}
        onStart={() => {}}
        onCancel={() => {}}
        onReset={() => {}}
        initialText="secret"
      />,
    );

    const passphraseToggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    click(passphraseToggle);
    expect(container.textContent).toContain("Passphrase strength");

    const generate = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Generate passphrase"),
    );
    click(generate ?? null);

    const passphraseInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(passphraseInput?.value.split("-").length).toBe(4);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ReceiverPanel } from "../src/components/ReceiverPanel";
import { SessionState } from "../src/lib/session";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

function completeState(receivedFiles: SessionState["receivedFiles"]): SessionState {
  return {
    phase: "complete",
    role: "responder",
    roomId: "room",
    inviteUrl: null,
    fingerprint: null,
    progress: null,
    error: null,
    receivedFiles,
    requiresPassphrase: false,
    expiresAt: null,
    reconnecting: false,
    recoveringConnection: false,
    delivered: false,
    itemCount: receivedFiles.length,
    connectionType: null,
    transferMode: "live",
    canStreamToDisk: false,
    savedToDisk: false,
  };
}

const baseProps = {
  mode: "live" as const,
  roomId: "room",
  linkSecret: "secret",
  requiresPassphrase: false,
  onJoin: () => {},
  onStoreJoin: () => {},
  onDownloadToDisk: () => {},
  onReset: () => {},
};

describe("<ReceiverPanel>", () => {
  it("blocks incomplete invite links before joining", () => {
    const onJoin = vi.fn();
    render(
      <ReceiverPanel
        {...baseProps}
        state={null}
        linkSecret={undefined}
        onJoin={onJoin}
      />,
    );

    expect(onJoin).not.toHaveBeenCalled();
    expect(container.textContent).toContain("missing its secret key");
  });

  it("explains resumable stored downloads while waiting for a save location", () => {
    render(
      <ReceiverPanel
        {...baseProps}
        mode="store"
        linkSecret="secret"
        state={{
          ...completeState([]),
          phase: "ready-to-save",
          transferMode: "store",
          canStreamToDisk: true,
        }}
      />,
    );

    expect(container.textContent).toContain("resume automatically");
  });

  it("offers one ZIP download action for two or more in-memory received files", () => {
    render(
      <ReceiverPanel
        {...baseProps}
        state={completeState([
          {
            blob: new Blob(["one"], { type: "image/png" }),
            meta: { name: "one.png", size: 3, mime: "image/png", transferId: "a" },
          },
          {
            blob: new Blob(["two"], { type: "application/octet-stream" }),
            meta: { name: "two.bin", size: 3, mime: "application/octet-stream", transferId: "b" },
          },
        ])}
      />,
    );

    expect(container.textContent).toContain("2 items received");
    const buttons = [...container.querySelectorAll("button")].map((button) =>
      button.textContent?.trim(),
    );
    expect(buttons).toContain("Download all (2)");
  });

  it("does not offer a ZIP action for a single received file", () => {
    render(
      <ReceiverPanel
        {...baseProps}
        state={completeState([
          {
            blob: new Blob(["one"], { type: "image/png" }),
            meta: { name: "one.png", size: 3, mime: "image/png", transferId: "a" },
          },
        ])}
      />,
    );

    expect(container.textContent).not.toContain("Download all");
  });
});

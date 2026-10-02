import type { FileSink } from "./file-sink";

export const MEMORY_RECEIVE_LIMIT = 64 * 1024 * 1024;
const BASE = "securesend-received";

/** Large receives must use storage, never silently fall back to a multi-GB heap. */
export async function createTemporaryFileSink(info: { name: string; size: number; mime: string }): Promise<FileSink> {
  if (typeof navigator.storage?.getDirectory !== "function" || typeof Worker === "undefined") {
    throw new Error("This browser cannot safely receive a file this large. Update Safari, or receive it on a desktop browser.");
  }
  const estimate = await navigator.storage.estimate?.();
  if (estimate?.quota !== undefined && estimate.usage !== undefined &&
      estimate.quota - estimate.usage < info.size + 16 * 1024 * 1024) {
    throw new Error("Not enough browser storage for this file. Free up space on this device and try again.");
  }
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle(BASE, { create: true });
  // Only remove our own abandoned temporary files, never another active transfer.
  const entries = base as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };
  for await (const name of entries.keys()) {
    const created = Number(name.split("-")[0]);
    if (created > 0 && Date.now() - created > 24 * 60 * 60 * 1000) {
      await base.removeEntry(name, { recursive: true }).catch(() => {});
    }
  }
  const directory = `${Date.now()}-${crypto.randomUUID()}`;
  const worker = new Worker(new URL("./receive-storage.worker.ts", import.meta.url), { type: "module" });
  let sequence = 0;
  let blob: Blob | null = null;
  let terminated = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const failPending = (message: string) => {
    for (const item of pending.values()) item.reject(new Error(message));
    pending.clear();
  };
  worker.onmessage = (event) => {
    const item = pending.get(event.data.id);
    if (!item) return;
    pending.delete(event.data.id);
    if (event.data.error) item.reject(new Error(event.data.error));
    else item.resolve(event.data.result);
  };
  const workerFailed = () => {
    terminated = true;
    worker.terminate();
    failPending("Could not write the received file to device storage. Update Safari or try another browser.");
  };
  worker.onerror = workerFailed;
  worker.onmessageerror = workerFailed;
  const call = (command: string, data: Record<string, unknown> = {}, transfer: Transferable[] = []) =>
    new Promise<unknown>((resolve, reject) => {
      if (terminated) return reject(new Error("Receive storage is closed"));
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, command, ...data }, transfer);
    });
  const remove = async () => {
    terminated = true;
    worker.terminate();
    failPending("Transfer cancelled");
    blob = null;
    await base.removeEntry(directory, { recursive: true }).catch(() => {});
  };
  try {
    await call("open", { ...info, directory });
  } catch (error) {
    await remove();
    throw error;
  }
  return {
    kind: "temporary",
    async write(chunk) {
      const copy = chunk.slice();
      await call("write", { bytes: copy.buffer }, [copy.buffer]);
    },
    async close() {
      blob = await call("finish") as Blob;
      terminated = true;
      worker.terminate();
    },
    async getBlob() {
      if (!blob) throw new Error("Received file is not ready to save");
      return blob;
    },
    dispose: remove,
    async abort() {
      if (!terminated) await call("abort").catch(() => {});
      await remove();
    },
  };
}

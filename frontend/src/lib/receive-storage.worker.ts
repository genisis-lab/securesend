/** Disk-backed receive storage for Safari, including versions without createWritable. */
export {};
interface AccessHandle {
  write(bytes: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};
let access: AccessHandle | null = null;
let directory: FileSystemDirectoryHandle;
let handle: FileSystemFileHandle;
let offset = 0;
let expected = 0;
let filename = "";
let mime = "";
let queue = Promise.resolve();
scope.onmessage = (event) => {
  const { id, command, ...data } = event.data;
  queue = queue.then(async () => {
    try {
      let result: unknown;
      if (command === "open") {
        const root = await navigator.storage.getDirectory();
        const base = await root.getDirectoryHandle("securesend-received", { create: true });
        directory = await base.getDirectoryHandle(data.directory, { create: true });
        handle = await directory.getFileHandle("payload", { create: true });
        access = await (handle as FileSystemFileHandle & {
          createSyncAccessHandle(): Promise<AccessHandle>;
        }).createSyncAccessHandle();
        expected = data.size;
        filename = data.name;
        mime = data.mime;
      } else if (command === "write") {
        if (!access) throw new Error("Receive file is closed");
        const bytes = new Uint8Array(data.bytes);
        if (offset + bytes.length > expected) throw new Error("Received more data than expected");
        let written = 0;
        while (written < bytes.length) {
          const count = access.write(bytes.subarray(written), { at: offset + written });
          if (count <= 0) throw new Error("Could not write received file");
          written += count;
        }
        offset += written;
      } else if (command === "finish") {
        if (!access || offset !== expected) throw new Error("The received file is incomplete");
        access.flush();
        access.close();
        access = null;
        // File references the on-disk bytes; never read it into an ArrayBuffer.
        result = new File([await handle.getFile()], filename, { type: mime });
      } else if (command === "abort") {
        access?.close();
        access = null;
      }
      scope.postMessage({ id, result });
    } catch (error) {
      const message = error instanceof DOMException && error.name === "QuotaExceededError"
        ? "Not enough free storage on this device to receive the file. Free up space and try again."
        : error instanceof Error ? error.message : "Could not save received data";
      scope.postMessage({ id, error: message });
    }
  });
};

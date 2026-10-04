import { describe, it, expect, vi } from "vitest";
import { sweepExpiredStores } from "../src/storage";

function bucketFixture() {
  const objects = new Map<string, string>();
  const bucket = {
    get: vi.fn(async (key: string) => objects.has(key) ? { text: async () => objects.get(key), json: async () => JSON.parse(objects.get(key)!) } : null),
    put: vi.fn(async (key: string, value: string) => { objects.set(key, value); }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
    list: vi.fn(async () => ({ objects: [...objects.keys()].map((key) => ({ key })), truncated: false })),
    resumeMultipartUpload: vi.fn(() => ({ abort: vi.fn(async () => {}) })),
  };
  return { objects, bucket, run: () => sweepExpiredStores(bucket as unknown as R2Bucket, 100) };
}

describe("scheduled upload expiration", () => {
  it("deletes expired ciphertext and retains active transfers", async () => {
    const { objects, bucket, run } = bucketFixture();
    for (const [id, expiresAt] of [["expired1234567890", 90], ["active12345678901", 110]] as const) {
      objects.set(id + ":meta", JSON.stringify({ uploaded: true, expiresAt }));
      objects.set("blob/" + id, "ciphertext");
    }
    await run();
    expect(objects.has("expired1234567890:meta")).toBe(false);
    expect(objects.has("blob/expired1234567890")).toBe(false);
    expect(objects.has("blob/active12345678901")).toBe(true);
    expect(bucket.resumeMultipartUpload).not.toHaveBeenCalled();
  });
  it("retains metadata after an abort failure for retry", async () => {
    const { objects, bucket, run } = bucketFixture();
    objects.set("expired1234567890:meta", JSON.stringify({ uploaded: false, expiresAt: 90, uploadId: "upload" }));
    bucket.resumeMultipartUpload.mockReturnValue({ abort: vi.fn(async () => { throw new Error("unavailable"); }) });
    await expect(run()).rejects.toThrow("retained for retry");
    expect(objects.has("expired1234567890:meta")).toBe(true);
  });
  it("persists the continuation cursor after four bounded pages", async () => {
    const { objects, bucket, run } = bucketFixture();
    bucket.list.mockResolvedValue({ objects: [], truncated: true, cursor: "next-page" } as any);
    await run();
    expect(bucket.list).toHaveBeenCalledTimes(4);
    expect(objects.get("maintenance/expiration-cursor")).toBe("next-page");
    expect(bucket.list).toHaveBeenLastCalledWith({ limit: 100, cursor: "next-page" });
  });
});

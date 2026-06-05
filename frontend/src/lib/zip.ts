/**
 * zip.ts — a tiny, dependency-free ZIP archive writer.
 *
 * Why hand-roll this? SecureSend ships no zip/compression dependency (we keep
 * the bundle small and audit-friendly), but "Download all" needs to hand the
 * recipient a SINGLE file. Bundling every received file into one archive is the
 * only approach that reliably works in one user gesture on iOS Safari, which
 * blocks the rapid-fire programmatic downloads a "save each file" loop needs.
 *
 * The archive uses the STORE method (no compression): received payloads are
 * usually already-compressed media, so DEFLATE would add CPU cost and code for
 * little or no size benefit. STORE keeps this dependency-free and fast.
 *
 * Everything is computed in memory from already-decrypted bytes; nothing here
 * touches the network. Pure and side-effect-free so it is easy to unit-test.
 *
 * Format reference: PKZIP APPNOTE — local file header, central directory, EOCD.
 * Sizes/offsets are 32-bit (no ZIP64), which is fine because the receiver
 * reassembles files in memory anyway (see LARGE_FILE_WARN_BYTES); a combined
 * archive over 4 GiB is not a realistic in-browser scenario.
 */

export interface ZipEntry {
  /** File name as it should appear inside the archive. */
  name: string;
  /** Raw file bytes (already decrypted). */
  data: Uint8Array;
}

/** Precomputed CRC-32 lookup table (IEEE 802.3 polynomial 0xEDB88320). */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 checksum of a byte array, as required by every ZIP entry. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encode a JS Date as the DOS date/time words used by ZIP headers. */
function dosDateTime(d: Date): { date: number; time: number } {
  // The DOS timestamp epoch starts in 1980; clamp anything older.
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date: date & 0xffff, time: time & 0xffff };
}

/** 32-bit size/offset ceiling (4 GiB - 1) — the limit without ZIP64. */
const MAX_ZIP_BYTES = 0xffffffff;

/**
 * Build a ZIP archive (STORE method) from the given entries and return it as a
 * Blob with the `application/zip` MIME type.
 */
export function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const { date, time } = dosDateTime(new Date());

  let total = 0;
  for (const e of entries) total += e.data.length + e.name.length + 76;
  if (total > MAX_ZIP_BYTES) {
    throw new Error("Archive too large for a 32-bit ZIP");
  }

  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const size = data.length;

    // ---- Local file header (30 bytes + name) ----
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true); // flags: bit 11 = UTF-8 file name
    lv.setUint16(8, 0, true); // compression method: 0 = store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size (== size for store)
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);
    parts.push(local, data);

    // ---- Central directory header (46 bytes + name) ----
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed to extract
    cv.setUint16(8, 0x0800, true); // flags: UTF-8 file name
    cv.setUint16(10, 0, true); // compression method: store
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true); // compressed size
    cv.setUint32(24, size, true); // uncompressed size
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra field length
    cv.setUint16(32, 0, true); // file comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal file attributes
    cv.setUint32(38, 0, true); // external file attributes
    cv.setUint32(42, offset, true); // relative offset of local header
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((n, c) => n + c.length, 0);
  const centralOffset = offset;
  for (const c of centralParts) parts.push(c);

  // ---- End of central directory record (22 bytes) ----
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(4, 0, true); // number of this disk
  ev.setUint16(6, 0, true); // disk with start of central directory
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true); // size of the central directory
  ev.setUint32(16, centralOffset, true); // offset of central directory
  ev.setUint16(20, 0, true); // .zip file comment length
  parts.push(end);

  // Concatenate into one ArrayBuffer-backed Uint8Array. (Building the Blob
  // directly from the parts array fails under the modern TS lib, where
  // Uint8Array is Uint8Array<ArrayBufferLike> and no longer satisfies the
  // BlobPart / ArrayBufferView<ArrayBuffer> requirement.)
  let totalLength = 0;
  for (const p of parts) totalLength += p.length;
  const merged = new Uint8Array(totalLength);
  let pos = 0;
  for (const p of parts) {
    merged.set(p, pos);
    pos += p.length;
  }

  return new Blob([merged], { type: "application/zip" });
}

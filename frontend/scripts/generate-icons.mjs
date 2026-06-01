/**
 * generate-icons.mjs
 *
 * Generates the PWA icons (192, 512, 512-maskable) as valid PNGs using only
 * Node's built-in `zlib` — no native image deps required. The icons are a
 * simple brand gradient with a lock glyph drawn from pixels.
 *
 * Run: node scripts/generate-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public", "icons");
mkdirSync(OUT_DIR, { recursive: true });

// ---- minimal PNG encoder (RGBA, no filtering) ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // rest zero (compression, filter, interlace)

  // raw scanlines with filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function makeIcon(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  // brand gradient endpoints
  const c1 = [0x6c, 0x8c, 0xff];
  const c2 = [0x4c, 0xd6, 0xb4];
  const bg = [0x0b, 0x10, 0x20];
  const pad = maskable ? Math.round(size * 0.12) : Math.round(size * 0.06);
  const radius = maskable ? size : Math.round(size * 0.22);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = (x + y) / (2 * size);
      // rounded-rect background mask
      const inRect = roundedRectContains(x, y, pad, pad, size - 2 * pad, size - 2 * pad, radius);
      if (!inRect && !maskable) {
        rgba[i] = bg[0];
        rgba[i + 1] = bg[1];
        rgba[i + 2] = bg[2];
        rgba[i + 3] = 0; // transparent corners
        continue;
      }
      // gradient fill
      let r = lerp(c1[0], c2[0], t);
      let g = lerp(c1[1], c2[1], t);
      let b = lerp(c1[2], c2[2], t);

      // draw a lock glyph in the center using dark pixels
      if (inLockGlyph(x, y, size)) {
        r = bg[0];
        g = bg[1];
        b = bg[2];
      }
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

function roundedRectContains(x, y, rx, ry, w, h, radius) {
  if (x < rx || y < ry || x >= rx + w || y >= ry + h) return false;
  const r = Math.min(radius, w / 2, h / 2);
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= rx + r && x < rx + w - r) || (y >= ry + r && y < ry + h - r);
}

function inLockGlyph(x, y, size) {
  const cx = size / 2;
  const bodyW = size * 0.34;
  const bodyH = size * 0.26;
  const bodyTop = size * 0.46;
  const bodyLeft = cx - bodyW / 2;
  // lock body
  if (
    x >= bodyLeft &&
    x <= bodyLeft + bodyW &&
    y >= bodyTop &&
    y <= bodyTop + bodyH
  ) {
    return true;
  }
  // shackle (ring)
  const ringCx = cx;
  const ringCy = bodyTop;
  const outer = size * 0.16;
  const inner = size * 0.1;
  const dx = x - ringCx;
  const dy = y - ringCy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (y <= bodyTop && d <= outer && d >= inner) return true;
  return false;
}

writeFileSync(join(OUT_DIR, "icon-192.png"), makeIcon(192, false));
writeFileSync(join(OUT_DIR, "icon-512.png"), makeIcon(512, false));
writeFileSync(join(OUT_DIR, "icon-512-maskable.png"), makeIcon(512, true));
console.log("Generated PWA icons in", OUT_DIR);

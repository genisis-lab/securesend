#!/usr/bin/env node
/**
 * check-pwa.mjs — deterministic PWA installability validator.
 *
 * WHY NOT LIGHTHOUSE: Lighthouse removed its dedicated "PWA" category in v12
 * (2024), so there's no PWA score to assert anymore. Instead we validate the
 * concrete browser install criteria directly against the built `dist/`:
 *   - a linked, well-formed web app manifest
 *   - name/short_name, start_url, display, icons (incl. 192 & 512), maskable
 *   - a generated service worker
 *   - share_target shape (so the file-share feature doesn't silently break)
 *
 * Runs with plain Node, no browser, no network — safe for CI. Exits non-zero
 * on any failure so it can gate the build.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

const problems = [];
const ok = [];
const fail = (m) => problems.push(m);
const pass = (m) => ok.push(m);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  if (!existsSync(dist)) {
    fail(`dist/ not found at ${dist} — run \`npm run build\` first.`);
    return report();
  }

  // 1. index.html links a manifest.
  const indexPath = resolve(dist, "index.html");
  if (!existsSync(indexPath)) {
    fail("dist/index.html is missing.");
  } else {
    const html = await readFile(indexPath, "utf8");
    if (/<link[^>]+rel=["']manifest["']/i.test(html)) {
      pass("index.html links a web app manifest.");
    } else {
      fail("index.html does not link a manifest (<link rel=\"manifest\">).");
    }
    if (/<meta[^>]+name=["']theme-color["']/i.test(html)) {
      pass("index.html declares a theme-color.");
    } else {
      fail("index.html is missing a theme-color meta tag.");
    }
  }

  // 2. Locate the manifest file (name varies: manifest.webmanifest).
  const manifestCandidates = ["manifest.webmanifest", "manifest.json"].map((f) =>
    resolve(dist, f),
  );
  const manifestPath = manifestCandidates.find((p) => existsSync(p));
  if (!manifestPath) {
    fail("No manifest.webmanifest / manifest.json in dist/.");
    return report();
  }

  let m;
  try {
    m = await readJson(manifestPath);
    pass("Manifest is valid JSON.");
  } catch (e) {
    fail(`Manifest is not valid JSON: ${e.message}`);
    return report();
  }

  // 3. Required identity + display fields.
  requireField(m, "name");
  requireField(m, "short_name");
  requireField(m, "start_url");
  const validDisplays = ["standalone", "fullscreen", "minimal-ui"];
  if (validDisplays.includes(m.display)) {
    pass(`display is installable ("${m.display}").`);
  } else {
    fail(`display must be one of ${validDisplays.join("/")}, got "${m.display}".`);
  }

  // 4. Icons: need at least 192px and 512px PNGs, plus a maskable icon.
  const icons = Array.isArray(m.icons) ? m.icons : [];
  const hasSize = (size) =>
    icons.some((i) => typeof i.sizes === "string" && i.sizes.split(" ").includes(`${size}x${size}`));
  if (hasSize(192)) pass("Has a 192x192 icon."); else fail("Missing a 192x192 icon.");
  if (hasSize(512)) pass("Has a 512x512 icon."); else fail("Missing a 512x512 icon.");
  const hasMaskable = icons.some((i) => /(^|\s)maskable(\s|$)/.test(i.purpose || ""));
  if (hasMaskable) pass("Has a maskable icon."); else fail("Missing a maskable icon (purpose: maskable).");

  // 5. Every icon file referenced actually exists in dist/.
  for (const icon of icons) {
    if (!icon.src) continue;
    const p = resolve(dist, icon.src.replace(/^\//, ""));
    if (existsSync(p)) pass(`Icon present: ${icon.src}`);
    else fail(`Icon referenced but missing in dist/: ${icon.src}`);
  }

  // 6. Screenshots (optional but unlock the rich install card) — if declared,
  //    the files must exist.
  for (const shot of m.screenshots || []) {
    if (!shot.src) continue;
    const p = resolve(dist, shot.src.replace(/^\//, ""));
    if (existsSync(p)) pass(`Screenshot present: ${shot.src}`);
    else fail(`Screenshot referenced but missing in dist/: ${shot.src}`);
  }

  // 7. Service worker generated.
  const swFound = ["sw.js", "service-worker.js"].some((f) =>
    existsSync(resolve(dist, f)),
  );
  if (swFound) pass("Service worker is present.");
  else fail("No service worker (sw.js) found in dist/.");

  // 8. share_target sanity (we rely on the POST file target).
  if (m.share_target) {
    const st = m.share_target;
    if (st.method && st.action) pass(`share_target declared (${st.method} ${st.action}).`);
    else fail("share_target is present but missing method/action.");
    const fileParam = st.params?.files;
    if (Array.isArray(fileParam) && fileParam.length > 0) {
      pass("share_target accepts files (POST file sharing enabled).");
    } else {
      // Not fatal — text/URL sharing still works.
      pass("share_target present (text/URL only; no file params).");
    }
  } else {
    pass("No share_target (optional).");
  }

  report();
}

function requireField(m, field) {
  if (m[field] && String(m[field]).length > 0) pass(`Manifest has ${field}.`);
  else fail(`Manifest is missing required field: ${field}.`);
}

function report() {
  for (const o of ok) console.log(`  \u2713 ${o}`);
  if (problems.length === 0) {
    console.log(`\nPWA check passed (${ok.length} checks).`);
    process.exit(0);
  }
  console.error(`\nPWA check FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  \u2717 ${p}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("check-pwa crashed:", e);
  process.exit(1);
});

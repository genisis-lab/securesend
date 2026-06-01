import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // injectManifest: we ship our own service worker (src/sw.ts) so we can
      // handle the POST file-share-target. The plugin still injects the
      // precache manifest and generates the registration module.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // "prompt" (not "autoUpdate"): we surface an "Update available" toast and
      // let the user reload, so a new version never auto-reloads the page and
      // interrupts an in-flight P2P transfer. See useServiceWorker.ts.
      registerType: "prompt",
      // We register the SW ourselves via `virtual:pwa-register` in the
      // useServiceWorker hook, so disable the auto-injected registration to
      // avoid registering twice.
      injectRegister: false,
      includeAssets: ["favicon.svg", "robots.txt"],
      manifest: {
        // Stable identity so the browser treats updates as the same app.
        id: "/?source=pwa",
        name: "SecureSend — Encrypted P2P File Transfer",
        short_name: "SecureSend",
        description:
          "End-to-end encrypted, peer-to-peer file transfer. Files never touch a server.",
        lang: "en",
        dir: "ltr",
        categories: ["utilities", "productivity", "security"],
        theme_color: "#0b1020",
        background_color: "#0b1020",
        display: "standalone",
        // Prefer the richest UI the platform supports, degrading gracefully.
        display_override: ["standalone", "minimal-ui"],
        orientation: "portrait",
        start_url: "/?source=pwa",
        scope: "/",
        // Focus an already-open window instead of spawning duplicates.
        launch_handler: { client_mode: "focus-existing" },
        icons: [
          {
            src: "icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        // Screenshots unlock the richer install dialog (with preview) on
        // Chromium. Provide both form factors so desktop and mobile both qualify.
        screenshots: [
          {
            src: "screenshots/mobile.png",
            sizes: "390x844",
            type: "image/png",
            form_factor: "narrow",
            label: "Create a secure invite link on mobile",
          },
          {
            src: "screenshots/desktop.png",
            sizes: "1280x800",
            type: "image/png",
            form_factor: "wide",
            label: "Send an encrypted file from the desktop",
          },
        ],
        // Long-press / right-click app icon shortcuts.
        shortcuts: [
          {
            name: "Send a file",
            short_name: "Send",
            description: "Start a new encrypted transfer",
            url: "/?source=shortcut",
          },
          {
            name: "Paste a link",
            short_name: "Receive",
            description: "Open a SecureSend invite you received",
            url: "/?source=shortcut-paste#paste",
          },
        ],
        // Receive shared content from the OS share sheet. POST multipart lets
        // us accept actual FILES (handled by our custom SW in src/sw.ts, which
        // stashes them and redirects into the app); title/text/url still ride
        // along for link/text shares.
        share_target: {
          action: "/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            files: [
              {
                name: "files",
                accept: ["*/*"],
              },
            ],
          },
        },
      },
      injectManifest: {
        // Precache the app shell only. Transferred file data is ephemeral,
        // P2P, and must never be persisted.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
      },
      devOptions: {
        // Enable SW in dev for testing the install prompt. Disable if noisy.
        enabled: false,
        type: "module",
      },
    }),
  ],
  server: {
    port: 5173,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
    },
  },
});

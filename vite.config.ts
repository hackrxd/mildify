/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // Svelte's default export condition is its server build, where runes don't react.
    conditions: process.env.VITEST ? ["browser"] : undefined,
    alias: {
      // The vendored Spicy Lyrics renderer; typed for the app by src/types/spicy-lyrics-renderer.d.ts.
      "spicy-lyrics-renderer": fileURLToPath(new URL("./src/spicy-lyrics/index.ts", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    // Built-in themes are imported as ?url; unprocessed CSS would give them an empty one.
    css: { include: [/src\/themes\//] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2022",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});

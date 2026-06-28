import { defineConfig } from "vite";
import { fileURLToPath } from "url";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../shared/src", import.meta.url)),
    },
  },
  server: {
    host: true, // expose on LAN so phones on the same WiFi can connect
    port: 5173,
  },
  build: {
    target: "es2020",
    outDir: "dist",
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    // Prefer the existing browser-storage origin, but never require its port.
    port: Number(process.env.FRONTEND_PORT || 5173),
    strictPort: false,
    proxy: process.env.EXITZERO_BACKEND_URL
      ? { "/api": process.env.EXITZERO_BACKEND_URL }
      : undefined,
  },
  preview: {
    host: "127.0.0.1",
    port: Number(process.env.FRONTEND_PORT || 4173),
    strictPort: false,
    proxy: process.env.EXITZERO_BACKEND_URL
      ? { "/api": process.env.EXITZERO_BACKEND_URL }
      : undefined,
  },
  test: { environment: "node", restoreMocks: true, unstubGlobals: true },
});

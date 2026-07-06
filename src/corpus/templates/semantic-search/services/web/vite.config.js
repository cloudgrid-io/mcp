import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Backend base URL is baked in at build time. Same-origin by default (the
// backend is mounted at /backend on the same entity), overridable via
// VITE_BACKEND_URL for split-origin dev.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
});

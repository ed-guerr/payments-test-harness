import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Renderer bundle. Output: dist/renderer/ (loaded by Electron main via
// loadFile). base "./" so asset paths work from the filesystem.
export default defineConfig({
  root: path.join(__dirname, "src", "renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.join(__dirname, "dist", "renderer"),
    emptyOutDir: true,
  },
});

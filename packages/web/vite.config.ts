import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
  resolve: { dedupe: ["react", "react-dom", "diff"] },
});

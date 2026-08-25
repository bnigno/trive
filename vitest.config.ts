import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Testes de integração sobem instâncias PGlite (Postgres WASM): limitamos o
    // paralelismo e alargamos timeouts para não saturar a CPU em suíte cheia.
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
});

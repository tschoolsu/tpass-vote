import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    // 只收頂層的純函式測試；tests/integration/ 需要資料庫與 build，走
    // vitest.integration.config.ts（pnpm test:integration）。
    include: ["tests/*.test.ts"],
  },
});

// 壓力測試：與整合測試同一套環境，但檔案分開、時限放寬，而且不會被 `pnpm test`
// 或 CI 誤觸——跑一次會塞幾百到幾千張票進測試庫。
//
//   pnpm build && pnpm stress            # 預設 500 位選舉人
//   STRESS_VOTERS=3000 pnpm stress       # 放大到 3000
//
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "tests/helpers/server-only-stub.ts"),
      "next/headers": path.resolve(__dirname, "tests/helpers/next-stubs/headers.ts"),
      "next/navigation": path.resolve(__dirname, "tests/helpers/next-stubs/navigation.ts"),
      "next/cache": path.resolve(__dirname, "tests/helpers/next-stubs/cache.ts"),
    },
  },
  test: {
    include: ["tests/stress/**/*.test.ts"],
    globalSetup: ["tests/helpers/global-setup.ts"],
    setupFiles: ["tests/helpers/setup.ts"],
    server: { deps: { inline: ["tpass-auth-js"] } },
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});

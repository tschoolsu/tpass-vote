// k6 前置：只準備資料（建選舉、灌名冊、簽 cookie），不自己起 app／jwks
// （那兩個由 tests/k6/start-server.mjs 起成長駐 process，活過這支 vitest 本身）。
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
    include: ["tests/k6/prep.test.ts"],
    server: { deps: { inline: ["tpass-auth-js"] } },
    setupFiles: ["tests/k6/setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

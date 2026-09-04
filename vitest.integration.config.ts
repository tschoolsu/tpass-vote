// 整合測試：需要本機 PostgreSQL（測試庫 t_vote_test）與 production build。
// 與單元測試（vitest.config.ts）分開，CI 只跑得動後者。
//
//   pnpm build && pnpm test:integration
//
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // server action / lib 幾乎都 import "server-only"，那個套件在 Node 直接 import 會炸。
      "server-only": path.resolve(__dirname, "tests/helpers/server-only-stub.ts"),
      // Next 的 request-scoped API 換成測試替身。用 alias 而非 vi.mock：tpass-auth-js 也
      // import next/headers，而 pnpm 的嚴格 node_modules 讓它在 Node 下解析不到 next。
      "next/headers": path.resolve(__dirname, "tests/helpers/next-stubs/headers.ts"),
      "next/navigation": path.resolve(__dirname, "tests/helpers/next-stubs/navigation.ts"),
      "next/cache": path.resolve(__dirname, "tests/helpers/next-stubs/cache.ts"),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // tpass-auth-js 自己 import next/headers，但 pnpm 的嚴格 node_modules 讓它在 Node
    // 底下解析不到 next。inline 它才會走 vite pipeline，上面的 alias 也才蓋得到。
    server: { deps: { inline: ["tpass-auth-js"] } },
    globalSetup: ["tests/helpers/global-setup.ts"],
    setupFiles: ["tests/helpers/setup.ts"],
    // 共用同一個測試資料庫，檔案之間不能並行。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});

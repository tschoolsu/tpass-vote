// 每個整合測試檔載入前跑：把 env 設好。server action 與 config 模組在 import 當下就會讀 env，
// 所以這件事必須發生在任何測試模組載入之前（vitest 的 setupFiles 保證了這個順序）。
//
// Next 的 request-scoped API（cookies / redirect / revalidatePath）改用 alias 換掉，
// 見 vitest.integration.config.ts。**guard、驗章、prisma 都不 mock**——授權與資料庫
// 是真的在跑，否則測不到東西。
import { testEnv } from "./env";

for (const [key, value] of Object.entries(testEnv())) {
  process.env[key] = value;
}

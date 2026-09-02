# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

# tpass-vote（T-Vote 學生會線上選舉系統）

學生會公告選舉、候選人登記／審核、匿名投票、開票。生態系總覽、`services.json` 註冊表與
`tpass` CLI 見上層 **tpass-ops** repo（`AGENTS.md`、`docs/`）。

## 鐵律

- 本機跑 `pnpm dev`（已設好 HTTPS + `vote.lvh.me:3006` + `NODE_TLS_REJECT_UNAUTHORIZED=0`；憑證在 `$HOME/tpass-certs`）。檢查用 `pnpm lint` + `pnpm exec tsc --noEmit`。
- UI 一律 light-only Neobrutalism + OKLCH，照 `tpass-portal/docs/design.md`。
- SSO 驗章在**套件 `tpass-auth-js`**（契約 v2，2026-08-27 起）——本 repo 只在 `src/config/auth.ts` 綁 env，callback / logout 兩條 route 各一行。四鐵則（EdDSA 鎖定 / issuer / audience=tpass:vote / exp）在套件裡且有測試守著；要改就去 `github.com/tschoolsu/tpass-auth-js` 改，**不要在這裡復活一份手抄的 `src/lib/tpass-auth.ts`**。只碰公鑰，絕不 import auth 的私鑰。
- 網域 / issuer / audience / DB 連線全 env 驅動（`src/config/auth.ts`），不寫死。
- 每個 server action / route handler 內部都要重呼 `require*` guard（`src/lib/guard.ts`），不能只靠 layout 擋。
- Schema 變更走 migration（migrations 進 git）；部署端 `deploy.sh` 跑 `prisma migrate deploy`。

## 本服務特有紅線（違反就是 bug）

- **開票私鑰永不上傳伺服器。** `Election.tallyPublicKeyJwk` 只存公鑰；私鑰只在選委會端本地產生、
  本地保管、開票時本地解密。任何 route / server action 都不得接收、儲存或記錄私鑰內容——
  收到看起來像私鑰的欄位要直接拒絕，不要「先存起來以後再說」。
- **選票密文表（`EncryptedBallot`）不得新增身分關聯欄位。** 目前只有 `voterId`（一人一格，
  用來擋重複/覆寫）與 `ciphertext`；不得加 `email`、`name`、`ip`、`userAgent` 或任何能回推
  投票內容與身分對應的欄位。`sealedBox`（`Election.sealedBox`）同理——彌封後必須去識別、
  已洗牌，不得殘留可追溯投票人的順序或索引。
- **mutation 一律 server action，且函式內部重新呼叫對應的 `require*` guard**——不能假設呼叫方
  已經在別處驗證過身分/權限，尤其是候選人審核、名冊上傳、彌封、開票這幾個高風險動作。
- 公告／政見的 Markdown 一律走 `src/components/public/Markdown.tsx`（切字串組 React element，天生免疫 XSS）——
  **不用 `dangerouslySetInnerHTML`、不引入 `react-markdown`**。
- 選舉狀態機（`Election.status`：draft → registration → campaigning → voting → closed → sealed →
  published）只能單向前進，不得由一般 mutation 任意回撥；狀態轉換要集中管理，不要散落在各頁面。

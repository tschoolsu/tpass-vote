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
- **選票密文表（`EncryptedBallot`）任何時候都不得有指得回選舉人的欄位，投票期間也不行。**
  選罷法 §26-1 Ⅳ 明文「本會不得記錄可回溯代碼與個別選舉人之連結」，而結果頁會公開
  代碼↔選票內容，連結一旦留存就等於公開誰投給誰。這張表只有 `id`／`electionId`／
  `ciphertext` 三個欄位，**加回 `voterId`、`email`、`name`、`ip`、`userAgent` 都是違法，
  不是效能取捨**；也不得加任何時間欄位（`createdAt`／`updatedAt`）或可排序的 id
  （`cuid()`、`uuid(7)`），那些等於用另一種形式把投票順序寫回去。一人一票改由
  `Voter.hasVoted` 的鎖內判定達成（`e/[slug]/vote/actions.ts`），同理 `Voter` 也只記
  有無、不記時間。這張表仍然是投票期間的暫存格，彌封時整場刪除；`sealedBox`
  （`Election.sealedBox`）同理——必須去識別、已洗牌，不得殘留可追溯投票人的順序或索引。
- **MVCC 邊界要誠實。** 上面那些只擋得住「查得到欄位的人」。Postgres 每列都有隱藏的
  `xmin`（寫入該列的交易 id），旗標與票是同一個交易寫的，所以拿 `xmin` 對 join 仍然
  對得起來。兩道對策：收票時擾動 K 列不相干的資料稀釋它（見 `PERTURB_K` 的註解），
  以及**關票時把整場的 `Voter` 與 `EncryptedBallot` 各原值改寫一次**，讓全部的列塌縮
  成同一個 xid（見 `advanceStatus` 裡 `next === "closed"` 那段）。**這兩段都不能拿掉，
  也不能因為「值沒變、看起來是廢話」就順手優化掉**——它們寫的是 xmin，不是欄位值。
  擾動只是稀釋（約 1.5% 的人仍會被侵蝕成唯一解），塌縮才是歸零，所以危險窗口是
  「投票進行中」，那段只能靠存取控制。**不要在文件或 UI 裡宣稱「資料庫裡不存在這個
  連結」**——正確的說法是「不存在於任何可查詢的欄位，關票後連 MVCC 線索也一併清掉」。
- **mutation 一律 server action，且函式內部重新呼叫對應的 `require*` guard**——不能假設呼叫方
  已經在別處驗證過身分/權限，尤其是候選人審核、名冊上傳、彌封、開票這幾個高風險動作。
- 公告／政見的 Markdown 一律走 `src/components/public/Markdown.tsx`（切字串組 React element，天生免疫 XSS）——
  **不用 `dangerouslySetInnerHTML`、不引入 `react-markdown`**。
- 選舉狀態機（`Election.status`：draft → registration → campaigning → voting → closed → sealed →
  published）只能單向前進，不得由一般 mutation 任意回撥；狀態轉換要集中管理，不要散落在各頁面。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

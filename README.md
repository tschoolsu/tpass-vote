# T-Vote — 學生會線上選舉系統

TSchool 數位服務平台的學生會選舉子模組（消費端）。公告、候選人登記與審核、匿名投票、
開票結果。透過 T-Pass SSO 認身分，**只用 JWKS 公鑰本地驗章**，不回呼 auth、不碰私鑰。

- 子網域（本機）：`https://vote.lvh.me:3006`（tpass-auth:3000 / tpass-portal:3001 之後）
- 技術棧：Next 16.3 + React 19 + Tailwind v4 + tpass-auth-js + Prisma 7 (Postgres)

> **目前狀態：功能完整，尚未部署（`tpass-registry` 的 `deployed:false`）。**
> 完整選舉流程：公告、候選人登記與補正審核、雙信封加密投票（截止前可跨裝置重投）、
> 彌封、本地開票、結果公告與重選場次；罷免、連署、補選、職務登記表亦已實作。
> 法規對應見下方〈選罷法對應〉。

## 本機啟動

1. **環境變數**：`cp .env.example .env.local`，填上 `DATABASE_URL`（本機慣例見下）。
   其餘 SSO / 網域變數已有本機預設值。管理員名單不在 env——在 auth 的 `/admin` panel 給角色。

2. **資料庫建表**：
   ```bash
   pnpm exec prisma migrate dev   # 套用 prisma/migrations；改 schema 後也用它產新 migration（不要 db push）
   ```
   或透過上層 ops repo：`scripts/tpass db setup vote`（冪等，會順便建 role/db）。

3. **HTTPS 憑證**（與 tpass-auth / tpass-portal 共用 mkcert，見上層 `docs/ONBOARDING.md`）。

4. **啟動**：
   ```bash
   pnpm dev   # https://vote.lvh.me:3006（package.json 已設好 HTTPS + NODE_TLS_REJECT_UNAUTHORIZED=0）
   ```

5. **登入**：用學校 Google 帳號（`auth` 服務需同時在跑）。管理權限來自通行證的 `permissions` claim（auth 的 `/admin` panel 設定）。

## 檢查

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

## 匿名投票機制：雙信封制

數位版對應紙本選舉：**內信封＝加密選票**（瀏覽器用本場選舉的 RSA-OAEP 公鑰做
envelope 加密，沒開票私鑰誰都打不開）、**外信封＝你的身分**（一人一格，重投＝覆寫，
截止前任何裝置可無限重投、以最後一次為準——這同時是反脅迫機制）、**開票＝先拆外信封**
（彌封：去識別＋密碼學洗牌成公開的票匭快照＋雜湊承諾），選委再於**瀏覽器本地**載入
金鑰檔解密計票；密文→明文的對應只存在選委瀏覽器記憶體。與愛沙尼亞 i-voting 同構。

計票規則：廢票是明確選項（`{type:"blank"}`）；超額競選＝相對多數（`choose`）、同額／不足額＝
同意投票（`approval`），開投時依核准人數自動判定。**同票不自動裁決**——只標示 `tied`，由選委
建立重選場次。開票結果**會**寫回伺服器（`Election.resultsJson`）；「本地運算」指加密與解密計票
發生在選委瀏覽器、私鑰不落地，不是指結果數字不存。

開票私鑰在建立選舉時於**選委瀏覽器本地**產生，下載成金鑰檔保管（可 XOR 兩份分持，
對應選罷法「兩名以上選委彌封、開票」），**伺服器從頭到尾沒有私鑰**。
⚠️ 金鑰檔弄丟＝該場選舉無法開票，只能重辦。

### 防護邊界（誠實版）

| 攻擊者 | 能否知道誰投給誰 |
| --- | --- |
| 應用程式碼、DB 管理員、DB 全量外洩 | ❌ 只看得到「誰投過」與打不開的密文（私鑰不在伺服器） |
| 持開票金鑰的選委（無 DB 權限） | ❌ 有鑰匙但拿不到「誰對應哪個密文」（票匭已去識別＋洗牌） |
| 脅迫者 | ⚠️ 受迫投完可換裝置重投，但 §26-1 Ⅳ 要求公開代碼↔選票內容，收據被搶走就證明得了內容。這是法規要求的可驗證性與反脅迫之間的取捨，不是實作疏漏 |
| **開票金鑰持有者＋DB 管理員合謀** | ⚠️ 僅限**彌封前**。彌封時 `EncryptedBallot` 整場刪除（§26-1 Ⅳ），此後連結不存在，合謀也回推不了。緩解：職權分離——金鑰在選委會（可兩人分持）、DB 在維運 |

完整性自檢：票匭快照（`/api/elections/<slug>/sealed-box`）與 `sealedHash` 公開，任何持鑰者可
重新解密驗算；伺服器雖然沒有私鑰，仍會用公開快照現算代碼、與選委提交的明細和票數逐項對帳，
不自洽就拒收。結果頁公開票數、領票數與每張票的去識別化內容，任何人可驗「沒有幽靈票」。

## 選罷法對應

依據《臺北市數位實驗高級中等學校學生會選舉罷免條例》第三版（2026-09-02，已通過）。
**條文全文在 `tpass-regulatory`（法規站）**，本 repo 不留副本——副本必然過期。
法規站上的正式條文由會長更新，在那之前全文暫時掛在該站的「草案公告」分類下。

| 條文 | 實作位置 |
| --- | --- |
| §12 單一選區相對多數決 / §13 複數選區單記不可讓渡 | `seats` + `maxChoices`（`grade_rep` 強制 `maxChoices=1`，見 `election-schema.ts`）、`src/lib/tally.ts` |
| §26 相對多數、同票由選委會裁決、同額改同意投票 | `src/lib/tally.ts`（`tied` 只標示不裁決） |
| §26-1 Ⅱ 投票期間 ≥ 48 小時 | `election-schema.ts` 表單驗證 ＋ `advanceStatus()` 開放投票時的閘門 |
| §26-1 Ⅳ 不記名、可回溯代碼於投票時提供 | `receiptOf()`（密文 SHA-256 前 12 碼），投票成功即顯示 |
| §26-1 Ⅳ 記錄去識別化個別意思 | `src/lib/disclosure.ts`、`Election.disclosuresJson` |
| §26-1 Ⅳ **不得記錄代碼與選舉人之連結** | 彌封時刪除 `EncryptedBallot`（`tally/actions.ts` 的 `sealElection`） |
| §26-1 Ⅴ 第三份公告附刊名冊與個別意思 | 結果頁的名冊區塊（登入會員可見）與去識別化明細表 |
| §26-1 Ⅵ 程式碼與運作資訊公開 | 本 repo 為 public；彌封快照 `/api/elections/<slug>/sealed-box` |
| §26-1 Ⅶ 選票載明號次、姓名、相片 | 候選人登記時相片必填（`register/actions.ts`），選票與候選卡皆顯示 |
| §26-1 Ⅷ 無效票各款 | `src/lib/tally.ts` 的 well-formed 判定（解不開、跨場、超額圈選、非本場候選人皆為無效） |
| §27／§28／§35／§36／§37／§38 罷免 | `src/lib/recall.ts`、`offices/[id]/recall/`、`result-announcement.ts` |

> §26-1 Ⅷ 一「重複投票者選票無效」：本系統的重投是**覆寫**，每位選舉人自始至終只有一張選票，
> 票匭裡不可能出現同一人的兩張票，故不構成重複投票。

### 權限矩陣

| 動作 | 誰能做 |
| --- | --- |
| 管理誰是管理員 | auth 的 `/admin` panel（本服務不自維護名單） |
| 開設選舉 / 狀態推進 / 名冊 / 審核候選人 / 公告 / 彌封 | `permissions.role` 不是 `default` 的人（admin／moderator） |
| 登記候選人 | 登入使用者（消極資格由選委會人工審） |
| 投票 | 選舉人名冊內的使用者（選委會逐場上傳 email） |
| 開票（解密計票） | 持有開票金鑰檔者（管理員頁面＋本地金鑰檔） |
| 下載候選人附件 | 管理員（`/api/files/[id]`，屬個資） |

## 架構備忘

- 驗章本體在共用套件 `tpass-auth-js`（`github:tschoolsu/tpass-auth-js`），四鐵則
  （`algorithms:['EdDSA']` / issuer / audience=`tpass:vote` / exp）在那裡且有測試守著。
  本 repo 只在 `src/config/auth.ts` 綁 env，callback / logout 兩條 route 各一行；
  要改驗章邏輯去那個 repo 改，**不要在這裡復活一份手抄的 `src/lib/tpass-auth.ts`**。
- 「誰能管選舉」只讀通行證的 `permissions` claim（`src/config/admin.ts` 的 `isAdmin`／`isSuperAdmin`），不查 DB、不讀 env；名單在 auth 的 `/admin` panel 管（2026-07-27 起，Admin 表已由 migration 砍掉）。
- 資料庫走 Prisma 7 + `@prisma/adapter-pg`（`src/lib/db.ts`），client 生成在 `src/generated/`（不進 git，`pnpm install` 的 postinstall 會產）；schema 改動只透過 `prisma migrate dev` 產 migration。準則見 tpass-ops `docs/handbook/01-new-service.md`〈資料庫〉。
- 開票私鑰永不落地：`Election.tallyPublicKeyJwk` 只存公鑰；`sealedBox` 是彌封（去識別、洗牌）後的密文快照。細節與紅線見 `AGENTS.md`。
- 檔案儲存 `src/lib/storage.ts` 預設 `local` driver（寫 `./.uploads`，本機 demo 用）；
  上線把 `STORAGE_DRIVER=s3` 接 Supabase Storage / S3，URL 全 env 驅動。

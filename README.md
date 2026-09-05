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
pnpm test            # 純函式單元測試（計票、明細、罷免門檻…），不需要資料庫
```

## 整合、資安與壓力測試

需要本機 PostgreSQL 與一次 `pnpm build`（打的是 production server，不是 dev）。
第一次要先建測試庫：

```bash
psql "postgresql://t_vote@localhost:5432/postgres" -c "CREATE DATABASE t_vote_test OWNER t_vote"
DATABASE_URL="postgresql://t_vote@localhost:5432/t_vote_test" pnpm exec prisma migrate deploy
```

之後：

```bash
pnpm build
pnpm test:integration                    # 程序測試 + 法規約束 + 資安（74 項）
pnpm stress --reporter=verbose           # 壓力測試，數字印在 console
BURST_VOTERS=3000 BURST_CONCURRENCY=500 pnpm stress   # 加大灌爆規模
```

測試怎麼繞過 Google 登入：`tests/helpers/` 起一個 JWKS stub，用**測試專用金鑰**
（`tests/helpers/test-keys.ts`，不是 auth 的真私鑰）簽出 `aud=tpass:vote` 的通行證。
驗章、授權、資料庫全部是真的在跑，只有 Next 的 `cookies()`／`redirect()` 換成替身。

- `tests/integration/flow.test.ts`：一場選舉從建立走到結果公告
- `tests/integration/legal.test.ts`：法規約束的負面案例（48 小時、SNTV、名單鎖定…）
- `tests/integration/security.test.ts`：驗章四鐵則、授權分級、IDOR、選票完整性
- `tests/integration/http.test.ts`：黑箱 HTTP（未登入、API 邊界、XSS、安全標頭）
- `tests/stress/load.test.ts`：各階段吞吐與延遲
- `tests/stress/burst.test.ts`：同時灌爆——瞬間併發遠超連線池上限、砍光 DB 連線、
  截止瞬間的競態、以及**盯著 server 的 RSS**（2026-09-02 事故的根因之一是記憶體上限
  被觸發後 pm2 進入重啟迴圈，這裡就是為了不再重演）

⚠️ 這些測試會清空 `t_vote_test`。`tests/helpers/db.ts` 有雙重防護（檢查連線字串與
`current_database()`），連錯庫會直接拒絕執行而不是清掉開發資料。

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
| 彌封前有 `EncryptedBallot` 讀權限者 | ❌ **已封堵**（2026-09-05）。可回溯代碼改由投票人瀏覽器產生、封在加密選票內部，伺服器與 DB 都只看得到密文，沒有開票私鑰就算不出代碼——再也無法建 `voterId↔代碼` 對照表去跟公開的 disclosures CSV join。代價是伺服器失去「代碼集合與票匭相符」這項對帳，只剩張數相符；結果造假的防線改為兩位選委各自獨立開票比對（見 SOP）。另外投票期間會把 `t_vote` 排除在每日備份外，避免備份留下彌封前的對應關係 |

完整性自檢：票匭快照（`/api/elections/<slug>/sealed-box`）與 `sealedHash` 公開，任何持鑰者可
重新解密驗算；伺服器雖然沒有私鑰，仍會驗張數相符、代碼不重複、各類票張數與逐票加總的得票數
與計票結果一致，不自洽就拒收——但**驗不了代碼本身**（代碼封在密文裡，伺服器算不出來）。
結果頁公開票數、領票數與每張票的去識別化內容，任何人可驗「沒有幽靈票」。

選委會實際操作的關票／彌封／開票步驟見 [`docs/election-sop.md`](docs/election-sop.md)。

## 選罷法對應

依據《臺北市數位實驗高級中等學校學生會選舉罷免條例》第三版（2026-09-02，已通過）。
**條文全文在 `tpass-regulatory`（法規站）**，本 repo 不留副本——副本必然過期。
法規站上的正式條文由會長更新，在那之前全文暫時掛在該站的「草案公告」分類下。

| 條文 | 實作位置 |
| --- | --- |
| §12 單一選區相對多數決 / §13 複數選區單記不可讓渡 | `seats` + `maxChoices`（`grade_rep` 強制 `maxChoices=1`，見 `election-schema.ts`）、`src/lib/tally.ts` |
| §26 相對多數、同票由選委會裁決、同額改同意投票 | `src/lib/tally.ts`（`tied` 只標示不裁決） |
| §26-1 Ⅱ 投票期間 ≥ 48 小時 | `election-schema.ts` 表單驗證 ＋ `advanceStatus()` 開放投票時的閘門 |
| §26-1 Ⅳ 不記名、可回溯代碼於投票時提供 | `newBallotCode()`：投票人瀏覽器產生 12 碼 hex，封在加密選票內部，投票成功當下顯示（伺服器看不到它） |
| §26-1 Ⅳ 記錄去識別化個別意思 | `src/lib/disclosure.ts`、`Election.disclosuresJson` |
| §26-1 Ⅳ **不得記錄代碼與選舉人之連結** | 兩層：代碼只存在於密文內部（無開票私鑰算不出來，含伺服器與 DB 讀取者）＋ 彌封時刪除 `EncryptedBallot`（`sealElection`）。投票期間另將 `t_vote` 排除在每日備份外 |
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

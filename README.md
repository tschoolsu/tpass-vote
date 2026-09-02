# T-Vote — 學生會線上選舉系統

TSchool 數位服務平台的學生會選舉子模組（消費端）。公告、候選人登記與審核、匿名投票、
開票結果。透過 T-Pass SSO 認身分，**只用 JWKS 公鑰本地驗章**，不回呼 auth、不碰私鑰。

- 子網域（本機）：`https://vote.lvh.me:3006`（tpass-auth:3000 / tpass-portal:3001 之後）
- 技術棧：Next 16.3 + React 19 + Tailwind v4 + tpass-auth-js + Prisma 7 (Postgres)

> **目前狀態：功能完整（v1）。** 完整選舉流程：三份法定公告、候選人登記與補正審核、
> 雙信封加密投票（截止前可跨裝置重投）、彌封、本地開票、結果公告與重選場次。
> 罷免與補選是 v2 範圍。

## 本機啟動

1. **環境變數**：`cp .env.example .env.local`，填上 `DATABASE_URL`（本機慣例見下）、
   `SUPER_ADMIN_EMAILS`。其餘 SSO / 網域變數已有本機預設值。

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

5. **登入**：用學校 Google 帳號（`auth` 服務需同時在跑）。`SUPER_ADMIN_EMAILS` 內的帳號視同管理員。

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

開票私鑰在建立選舉時於**選委瀏覽器本地**產生，下載成金鑰檔保管（可 XOR 兩份分持，
對應選罷法「兩名以上選委彌封、開票」），**伺服器從頭到尾沒有私鑰**。
⚠️ 金鑰檔弄丟＝該場選舉無法開票，只能重辦。

### 防護邊界（誠實版）

| 攻擊者 | 能否知道誰投給誰 |
| --- | --- |
| 應用程式碼、DB 管理員、DB 全量外洩 | ❌ 只看得到「誰投過」與打不開的密文（私鑰不在伺服器） |
| 持開票金鑰的選委（無 DB 權限） | ❌ 有鑰匙但拿不到「誰對應哪個密文」（票匭已去識別＋洗牌） |
| 脅迫者 | ❌ 受迫投完可換裝置重投；收據只證明入匭、不證明內容（不能拿去賣票邀功） |
| **開票金鑰持有者＋DB 管理員合謀** | ⚠️ 可以。緩解：職權分離——金鑰在選委會（可兩人分持）、DB 在維運。這與紙本選舉的信任模型相同（兩名選委合謀也能作弊），且是「跨裝置重投＋匿名」需求組合的理論下限 |

完整性自檢：票匭快照與 `sealedHash` 公開，任何持鑰者可重新解密驗算（可重複計票）；
結果頁公開票數與領票數，任何人可驗「沒有幽靈票」。

### 權限矩陣

| 動作 | 誰能做 |
| --- | --- |
| 管理 Admin 名單 | 超管（`SUPER_ADMIN_EMAILS`） |
| 開設選舉 / 狀態推進 / 名冊 / 審核候選人 / 公告 / 彌封 | 管理員（超管 ∪ DB Admin 表） |
| 登記候選人 | 登入使用者（消極資格由選委會人工審） |
| 投票 | 選舉人名冊內的使用者（選委會逐場上傳 email） |
| 開票（解密計票） | 持有開票金鑰檔者（管理員頁面＋本地金鑰檔） |
| 下載候選人附件 | 管理員（`/api/files/[id]`，屬個資） |

## 架構備忘

- 驗章本體在共用套件 `tpass-auth-js`（`github:tschoolsu/tpass-auth-js`），四鐵則
  （`algorithms:['EdDSA']` / issuer / audience=`tpass:vote` / exp）在那裡且有測試守著。
  本 repo 只在 `src/config/auth.ts` 綁 env，callback / logout 兩條 route 各一行；
  要改驗章邏輯去那個 repo 改，**不要在這裡復活一份手抄的 `src/lib/tpass-auth.ts`**。
- 「誰能管選舉」auth 不管，全在 `src/config/admin.ts` 的消費端白名單（env 種子 ∪ DB）。
- 資料庫走 Prisma 7 + `@prisma/adapter-pg`（`src/lib/db.ts`），client 生成在 `src/generated/`（不進 git，`pnpm install` 的 postinstall 會產）；schema 改動只透過 `prisma migrate dev` 產 migration。準則見 tpass-ops `docs/handbook/01-new-service.md`〈資料庫〉。
- 開票私鑰永不落地：`Election.tallyPublicKeyJwk` 只存公鑰；`sealedBox` 是彌封（去識別、洗牌）後的密文快照。細節與紅線見 `AGENTS.md`。
- 檔案儲存 `src/lib/storage.ts` 預設 `local` driver（寫 `./.uploads`，本機 demo 用）；
  上線把 `STORAGE_DRIVER=s3` 接 Supabase Storage / S3，URL 全 env 驅動。

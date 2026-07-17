# T-Vote — 學生會線上選舉系統

TSchool 數位服務平台的學生會選舉子模組（消費端）。公告、候選人登記與審核、匿名投票、
開票結果。透過 T-Pass SSO 認身分，**只用 JWKS 公鑰本地驗章**，不回呼 auth、不碰私鑰。

- 子網域（本機）：`https://vote.lvh.me:3006`（tpass-auth:3000 / tpass-portal:3001 之後）
- 技術棧：Next 16.2.9 + React 19 + Tailwind v4 + jose + Prisma(Postgres)

> **目前狀態：Phase 1（骨架＋SSO＋schema）。** 選舉列表、候選人登記、投票、開票等業務邏輯
> 尚未實作——首頁只是登入態占位頁。

## 本機啟動

1. **環境變數**：`cp .env.example .env.local`，填上 `DATABASE_URL`（本機慣例見下）、
   `SUPER_ADMIN_EMAILS`。其餘 SSO / 網域變數已有本機預設值。

2. **資料庫建表**：
   ```bash
   pnpm exec prisma migrate dev   # 套用既有 migrations（或視需要新增）
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

## 防護邊界（TODO：Phase 5 補完整版）

| 動作 | 誰能做 | 狀態 |
| --- | --- | --- |
| 建立/管理 Admin 名單 | 超管（`SUPER_ADMIN_EMAILS`） | TODO |
| 開設選舉 / 編輯公告 / 審核候選人 | 管理員（超管 ∪ DB Admin 表） | TODO |
| 登記候選人 | 登入使用者 | TODO |
| 投票 | 選舉人名冊內的使用者 | TODO |
| 開票 / 彌封 | 持有開票私鑰的選委會（本地解密，見 `AGENTS.md`） | TODO |
| 下載候選人附件 | 管理員 | 已實作（`/api/files/[id]`） |

## 架構備忘

- 驗章四鐵則在 `src/lib/tpass-auth.ts`（照抄 tpass-portal 參考實作）：`algorithms:['EdDSA']` / issuer / audience / exp。
- 「誰能管選舉」auth 不管，全在 `src/config/admin.ts` 的消費端白名單（env 種子 ∪ DB）。
- 開票私鑰永不落地：`Election.tallyPublicKeyJwk` 只存公鑰；`sealedBox` 是彌封（去識別、洗牌）後的密文快照。細節與紅線見 `AGENTS.md`。
- 檔案儲存 `src/lib/storage.ts` 預設 `local` driver（寫 `./.uploads`，本機 demo 用）；
  上線把 `STORAGE_DRIVER=s3` 接 Supabase Storage / S3，URL 全 env 驅動。

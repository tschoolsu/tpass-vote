# T-Vote 交接文件（2026-07-17）

> 給下一個 session / agent：接手前先讀本檔＋`AGENTS.md`＋`README.md`（防護邊界表）。
> 設計定案過程在 `~/.claude/plans/ai-agent-stateless-petal.md`（若還在）。

## 0. 一句話

T-Vote（id `vote`、port 3006、`tpass-vote` repo）是依《學生自治會選舉罷免法》做的
線上選舉模組。**v1 功能已寫完、單元測試與 build 全綠，但端到端瀏覽器實測還沒跑完**（見 §3）。

## 1. 核心設計決策（別推翻，都是使用者拍板的）

- **雙信封制**（Estonia i-voting 同構）：選票在瀏覽器用選舉公鑰 envelope 加密
  （RSA-OAEP-256 + A256GCM），綁 voterId 一人一格 upsert。開票私鑰只在選委手上
  （建選舉時瀏覽器本地產生、下載金鑰檔，可 XOR 兩份分持），伺服器從未持有。
- **盲簽章方案被否決**：使用者要「跨裝置無限重投、以最後一次為準」（反脅迫：在校被逼投、
  回家用手機改回來），盲簽章做不到跨裝置。殘餘風險（金鑰持有者＋DB 管理員合謀可破匿名）
  使用者已知悉，README 防護邊界表有寫。
- **同票不自動裁決**：法條寫抽籤、使用者傾向重選——系統只標示 tied＋提供「建立重選場次」
  （`createRunoff`，parentId 關聯）。
- 廢票是明確選項（`{type:"blank"}`）；超額＝choose 相對多數、同額/不足額＝approval
  （同意>不同意），開投時依核准人數自動判定 `ballotMode`。
- 名冊＝選委會逐場貼 email；權限＝`SUPER_ADMIN_EMAILS` env 種子 ∪ DB Admin 表
  （不用 JWT role——生態系鐵律）。
- 每個環節（詳情/三公告/投票/結果）都有獨立 slug 網址＋複製連結＋OG meta（貼 Google Chat 用）。

## 2. 已完成（tpass-vote 三個 commit）

| commit | 內容 |
| --- | --- |
| `2da3cc0` | 骨架＋SSO 四檔＋guard＋Prisma schema（migration `20260717061026_init`）＋Upload |
| `b48e445` | 加密核心：`src/lib/ballot-crypto.ts`（信封加密/金鑰分持/收據/形狀檢查）、`tally.ts`（計票純函式）、`vote-policy.ts`、`tally-client.ts`（開票組合）、castBallot / sealElection / submitResults actions、25 個 vitest |
| `f763fd9` | 管理端（`src/app/admin/**`）＋公開端（`src/app/e/**`、`page.tsx`）全部 UI＋README 防護邊界表 |

驗證狀態：`pnpm lint`／`pnpm exec tsc --noEmit`／`pnpm build`／`pnpm test`（25 tests）全綠。
安全抽查過：所有 server action 第一行 guard、`savePublicKey` 拒收私鑰欄位 JWK、
投票只送密文出瀏覽器、金鑰檔只活在 component state。

生態系接線（已完成、**但 ops 與 portal repo 的改動未 commit**）：
- `../services.json` 加了 vote（`M`，未 commit）
- `../tpass-portal/src/config/services.ts` 加了卡片＋`VOTE_URL` REQUIRED（未 commit）
- mkcert 憑證已含 `vote.lvh.me`；auth `.env.local` 的 `AUTH_SERVICE_IDS` 已加 vote；
  portal `.env.local` 已加 `VOTE_URL`；vote `.env.local` 的 `SUPER_ADMIN_EMAILS=11430112@tschool.tp.edu.tw`

## 3. 沒做完的：端到端瀏覽器實測（下一步就是這個）

單元測試綠≠流程通。完整劇本（照做即可）：

1. `pnpm dev`（vote）＋ tpass-auth `pnpm dev` 同時跑，`https://vote.lvh.me:3006` Google 登入
2. `/admin` 建選舉（kind=leader、slug 任意、名額 1、投票時間涵蓋現在）→ 產金鑰選 2 份分持
   → 下載兩檔 → 存公鑰
3. 名冊貼自己 email（＋幾個假的湊分母）→ 推進 registration → 前台 `/e/<slug>/register`
   登記正副兩人 → 管理端退回補正 → 前台重送 → 核准＋號次
4. 發布第一、二公告 → 無痕確認獨立頁免登入可看
5. 推進 voting（驗 ballotMode 自動判定：1 組候選人＝approval）→ 投票記收據
   → **無痕重新登入投相反選擇**（驗重投提示＋新收據＋DB 仍只有一列密文）
6. 推進 closed → 彌封 → 開票頁：只上傳一份金鑰檔應被拒 → 兩份齊 → 本地解密
   → 驗結果＝最後一次的選擇、總票數 1 → 提交結果
7. 發布結果公告（sealed→published）→ 無痕看 `/e/<slug>/results`：
   新收據查詢「已入匭」、舊收據「查無」
8. DB 抽查：`EncryptedBallot` 只有 ciphertext 無其他身分外欄位、`sealedBox` 無身分、
   `tallyPublicKeyJwk` 無 `d/p/q` 欄位

已知小事：build 後 `.next/types` 被清會讓 `tsc` 報 `RouteContext` 找不到——跑
`pnpm exec next typegen` 即解。

## 4. v1 收尾待辦（實測過了才做）

- [ ] 端到端劇本（§3）跑通，壞的修掉
- [ ] ops repo commit（`services.json`）＋ portal commit（services.ts 卡片）
- [ ] 建 GitHub remote `YC815/tpass-vote` 並 push（使用者傾向 **public**——透明性訴求；
      push 前確認 repo 內無任何機密，`.env.local` 已 gitignore）
- [ ] `INTEGRATION.md §12` 驗收清單（四種假 token 401、audience 隔離、cookie host-only）
- [ ] 部署走 `docs/NEW-SERVICE.md §5` 十步（DNS/nginx/建 DB 要維運）；部署清單加一條：
      **請維運對 `/api/vote/cast` 與投票相關路由關 nginx access log**（降時間關聯風險）；
      上線後 `services.json` 的 `deployed` 翻 true
- [ ] 上線前把 `STORAGE_DRIVER` 從 local 換 s3（`src/lib/storage.ts`）

## 5. v2 待辦（使用者已定案範圍）

- **罷免**：連署（當屆有效票總數 2/5 門檻）、就職未滿 2 個月不得提、成立後 30 日內投票、
  同意>不同意通過、通過即解職＋45 日內補選、否決後同一事由同任期不得再提
- **補選**：可能可以重用 `createRunoff` 的複製模式（parentId 已有）
- 法定時限目前只「提示」不強制（公告一≥投票前 30 日等）——v2 可考慮硬擋或要求確認
- 小重構：`LOCKED_STATUSES` 在幾個 admin actions 重複定義（管理端 agent 回報過），
  可集中到 `src/lib/election-status.ts`
- 金鑰遺失的補救 UX（現在只能重辦選舉——至少給個清楚的重辦流程）

## 6. 慣例提醒（踩過的坑）

- 派 subagent 一律指定 `model`（sonnet/haiku，最高 opus），**別讓它繼承 fable**（貴）
- 各服務 `.env.local` 有權限擋，agent 讀不到也改不了——要改就給使用者一行 `!` 指令
- Next 16：`params` 是 Promise；寫前看 `node_modules/next/dist/docs/`
- 本機 Postgres role 建立腳本（`scripts/lib/db.mjs`）沒給 `CREATEDB`，`prisma migrate dev`
  需要 shadow db——`t_vote` 已手動 `ALTER ROLE t_vote CREATEDB`，新環境要重做

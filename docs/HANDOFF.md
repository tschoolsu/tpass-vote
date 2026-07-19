# T-Vote 交接文件（2026-07-18）

> 給下一個 session / agent：接手前先讀本檔＋`AGENTS.md`＋`README.md`（防護邊界表）。
> 三方流程/介面重構定案過程在 `~/.claude/plans/tpass-vote-handoff-md-agent-haiku-sonne-logical-crab.md`（若還在）。

## 0. 一句話

T-Vote（id `vote`、port 3006、`tpass-vote` repo）是依《學生自治會選舉罷免法》做的
線上選舉模組。**功能與三方流程/介面重構已寫完，單元測試（29）＋lint＋tsc＋build 全綠、
DB migration 已套用，但端到端瀏覽器實測還沒跑（需真人 Google 登入）**（見 §3）。

## 1. 核心設計決策（別推翻，都是使用者拍板的）

- **雙信封制**（Estonia i-voting 同構）：選票在瀏覽器用選舉公鑰 envelope 加密
  （RSA-OAEP-256 + A256GCM），綁 voterId 一人一格 upsert。開票私鑰只在選委手上
  （建選舉時瀏覽器本地產生、下載金鑰檔，可 XOR 兩份分持），伺服器從未持有。
- **盲簽章方案被否決**：使用者要「跨裝置無限重投、以最後一次為準」（反脅迫）。殘餘風險
  （金鑰持有者＋DB 管理員合謀可破匿名）使用者已知悉，README 防護邊界表有寫。
- **同票不自動裁決**：只標示 tied＋提供「建立重選場次」（`createRunoff`，parentId 關聯）。
- 廢票是明確選項（`{type:"blank"}`）；超額＝choose 相對多數、同額/不足額＝approval，
  開投時依核准人數自動判定 `ballotMode`。
- 名冊＝選委會逐場貼 email；權限＝`SUPER_ADMIN_EMAILS` env 種子 ∪ DB Admin 表（不用 JWT role）。
- **開票結果一直有存伺服器**（`Election.resultsJson`，`submitResults` 寫入）——「本地運算」
  指的是加密與計票過程在選委瀏覽器發生、私鑰不落地，不是指結果數字不存。

## 2. 已完成

### 2a. v1 核心（三個 commit：`2da3cc0` / `b48e445` / `f763fd9`）
骨架＋SSO 四檔＋guard＋Prisma＋Upload；加密核心（`src/lib/ballot-crypto.ts`、`tally.ts`、
`vote-policy.ts`、`tally-client.ts`）；castBallot/sealElection/submitResults actions；
管理端與公開端全部 UI＋README 防護邊界表。

### 2b. 三方流程/介面重構（2026-07-18，**尚未 commit**）
使用者要求對「投票者／候選人／管理員」三方重新設計流程與介面，讓沒有技術背景的選務人員
無負擔使用。已完成：

**管理員——全合併單頁工作台**（取代原本「總覽頁＋跳頁子頁」）
- `src/app/admin/elections/[id]/page.tsx` 重寫成單頁線性工作台；panel 元件在
  `src/components/admin/panels/*`（`ElectionWorkbench`／`StageProgress` ①–⑦ 進度列／
  `CurrentStageCard` 當前該做什麼／`WorkbenchAccordion` 七步收合／`SettingsPanel`／
  `RegistrationPanel`／`CampaignVotingPanel`／`SealPanel`／`TallyPanel`／`ResultsAnnouncementPanel`）。
- 開票那格**原封嵌入既有 `TallyClient`**（加密/私鑰只活在 component state 的流程完全沒動）。
- 舊子路由 `roster`／`candidates`／`edit`／`tally`／`announcements` 的 `page.tsx` 全部改
  `redirect()` 到工作台（單一入口，消掉跨頁導覽斷裂）；它們的 `actions.ts` 保留、被 panel 呼叫。

**公告——自由公告流**（取代原本「固定三則法定公告」）
- schema：`Announcement.kind`（first|second|result，NOT NULL，每場唯一）→ `legalTag String?`
  （nullable），拿掉 `@@unique`，加 `@@index([electionId])`。migration
  `20260717141435_announcements_free_flow` **已套用本機 `t_vote`**。
- 公告介面（`src/components/admin/panels/AnnouncementsSection.tsx`）＝三部分：**純公告發布**
  （「＋發新公告」，一律 `legalTag=null`，無類型選擇）／**公告建議**（軟提示：登記·投票公告、
  候選人名單、結果公告的建議時機，純展示不追蹤）／**公告歷史**（所有已發布公告時間軸）。
- **例外：結果公告 `legalTag='result'`** 是唯一特殊 tag——不進上面的自由介面，改由步驟⑦
  `ResultsAnnouncementPanel` 編輯發布。`saveAnnouncementDraft`/`publishAnnouncement`
  （`announcements/actions.ts`）以 id 決定新建/更新，`resolveTarget` 只保護 result 唯一性；
  發布 result（且 sealed）在同一交易翻 `published`（**這是 published 的唯一觸發點**，一般公告
  發布絕不改狀態）。
- **開票→自動生成結果公告草稿**：`submitResults`（`tally/actions.ts`）成功寫 `resultsJson` 後，
  於同一 `$transaction` upsert 一則 `legalTag='result'` 草稿，內容由純函式
  `src/lib/result-announcement.ts` 的 `resultAnnouncementDraft()` 產生（Markdown 子集，
  有單元測試）。選委在步驟⑦小編後發布 → 結案。

**狀態機集中**
- 新建 `src/lib/election-status.ts`（`ELECTION_STATUSES`／`NEXT_STATUS`／`LOCKED_STATUSES`／
  `nextStatus`／`isLocked`）——原本散在 6 個檔案的 `LOCKED_STATUSES` 已收斂於此（v2 待辦已消）。
  `src/components/admin/status.ts` 只留顯示 meta（`STATUS_META`／`CANDIDATE_STATUS_META`）。

**候選人——政見 markdown ＋預覽**
- `src/components/public/Markdown.tsx` 擴充：新增 `###` 三級標題、`[文字](url)`（scheme 白名單
  http/https/mailto，其餘降級純文字）——維持切字串組 React element、**永不 `dangerouslySetInnerHTML`**、
  不引入 `react-markdown`。
- `RegisterForm.tsx` 政見欄位加「撰寫/預覽」切換；`CandidateCard.tsx` 政見改 `<Markdown>` 渲染
  （新增 `expanded` prop）。

**投票者——資訊清晰化**
- `VoteForm.tsx`：候選人政見預設展開、加「送出前確認摘要」、收據含複製與白話說明（重投規則/
  匿名性/結果頁查詢）；`vote/page.tsx` 重投提示文案優化。**加密/`castBallot`/收據/重投 upsert 沒動。**

**首頁／透明頁**
- `src/app/page.tsx`：未登入不再強制重導，改 landing（介紹＋登入 CTA＋透明頁入口＋GitHub）。
- 新增免登入 `src/app/about/page.tsx`（白話：雙信封制/瀏覽器端加密/跨裝置重投/殘餘風險誠實版）。
- `src/config/site.ts` 的 `GITHUB_URL = https://github.com/YC815/tpass-vote`；
  `src/components/public/GithubMark.tsx` 自製 SVG（lucide-react 這版已移除品牌 icon）。

**公開端公告路由改 per-id**
- `/e/[slug]/a/[kind]` → `/e/[slug]/a/[id]`（依 announcement id、未發布 404、每則獨立 OG meta）；
  `e/[slug]/page.tsx` 公告列表改列全部已發布公告連到各自 id。

驗證：`pnpm lint`／`pnpm exec tsc --noEmit`／`pnpm test`（29）／`pnpm build` **全綠**。

## 3. 沒做完的：端到端瀏覽器實測（下一步就是這個）

單元/型別/build 綠 ≠ 流程通。**Google 登入不能自動化（違反條款、會被擋）——必須真人手動登入。**
完整劇本：

1. `scripts/tpass dev`（同起 vote + auth，HTTPS + SSO），`https://vote.lvh.me:3006` Google 登入
2. `/admin` 建選舉（kind=leader、名額 1、投票時間涵蓋現在）→ 工作台①設定：產金鑰選 2 份分持
   → 下載兩檔 → 存公鑰 → 名冊貼自己 email（＋幾個假的湊分母）
3. 推進 registration → 前台 `/e/<slug>/register` 登記正副兩人（**驗政見撰寫/預覽切換**）
   → 工作台②退回補正 → 前台重送 → 核准＋號次
4. 工作台公告區塊：**發 1–2 則一般公告**（驗純介面/建議/歷史三部分）→ 無痕確認
   `/e/<slug>/a/<id>` 免登入可看
5. 推進 voting（驗 ballotMode 自動判定）→ 前台投票（**驗政見預設展開、送出前確認、收據複製**）
   → 無痕重新登入投相反選擇（驗重投提示＋新收據＋DB 仍只有一列密文）
6. 推進 closed → 工作台⑤彌封 → ⑥開票：只上傳一份金鑰應被拒 → 兩份齊 → 本地解密
   → 驗結果＝最後一次選擇、總票數 1 → 提交結果
7. **驗步驟⑦自動出現結果公告草稿、文字讀起來通順** → 小編 → 發布（驗 sealed→published 結案）
   → 無痕看 `/e/<slug>/results`：新收據「已入匭」、舊收據「查無」
8. 首頁未登入可見 landing＋`/about`＋GitHub 連結
9. DB 抽查：`EncryptedBallot` 只有 ciphertext、`sealedBox` 無身分、`tallyPublicKeyJwk` 無 `d/p/q`

已知小事：build 後 `.next/types` 被清會讓 `tsc` 報 `RouteContext` 找不到——跑 `pnpm exec next typegen` 即解。

## 4. 收尾待辦（實測過了才做）

- [ ] 端到端劇本（§3）跑通，壞的修掉
- [ ] **本次重構全部 commit**（tpass-vote：工作台/公告/markdown/首頁/schema+migration）
      ＋ ops repo commit（`services.json`）＋ portal commit（services.ts 卡片）
- [ ] 建 GitHub remote `YC815/tpass-vote` 並 push（**public**——透明性訴求；push 前確認無機密、
      `.env.local` 已 gitignore）
- [ ] `INTEGRATION.md §12` 驗收清單（四種假 token 401、audience 隔離、cookie host-only）
- [ ] 部署走 `docs/NEW-SERVICE.md §5` 十步；部署清單加一條：**請維運對 `/api/vote/cast` 與
      投票相關路由關 nginx access log**（降時間關聯風險）；上線後 `services.json` 的 `deployed` 翻 true
- [ ] 上線前把 `STORAGE_DRIVER` 從 local 換 s3（`src/lib/storage.ts`）
- [ ] 小清理：`src/components/public/shared.ts` 的 `LEGAL_TAG_LABEL/LEGAL_TAGS` 還留 first/second
      舊標籤（只服務萬一存在的舊資料顯示，無害）；DB 若有殘留 `legalTag='first'/'second'` 的
      **未發布**舊草稿，新 UI 無入口編輯，需手動把 legalTag 改 null 或刪除。

## 5. v2 待辦（使用者已定案範圍）

- **罷免**：連署（當屆有效票總數 2/5 門檻）、就職未滿 2 個月不得提、成立後 30 日內投票、
  同意>不同意通過、通過即解職＋45 日內補選、否決後同一事由同任期不得再提
- **補選**：可能重用 `createRunoff` 的複製模式（parentId 已有）
- 法定時限目前只「提示」不強制（公告建議等）——v2 可考慮硬擋或要求確認
- 金鑰遺失的補救 UX（現在只能重辦選舉——至少給個清楚的重辦流程）

## 6. 慣例提醒（踩過的坑）

- 派 subagent 一律指定 `model`（sonnet 寫程式／haiku 撈資料，最高 opus），**別讓它繼承 fable**（貴）
- 各服務 `.env.local` 有權限擋，agent 讀不到也改不了——要改就給使用者一行 `!` 指令。
  Prisma CLI 只讀 `.env` 不讀 `.env.local`；套 migration 走 `scripts/tpass db setup vote`
  （會把 `.env.local` 匯入環境再跑 prisma）。
- Next 16：`params` 是 Promise；寫前看 `node_modules/next/dist/docs/`
- 本機 Postgres role（`scripts/lib/db.mjs`）沒給 `CREATEDB`，`prisma migrate dev` 需要 shadow db
  ——`t_vote` 已手動 `ALTER ROLE t_vote CREATEDB`，新環境要重做。

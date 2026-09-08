# 登記上傳：圖片自動壓縮與失敗引導

日期：2026-09-08
狀態：設計完成，待實作

## 問題

候選人登記表單（`/e/[slug]/register`）的大頭照與學生證影本上傳，遇到大檔會失敗，
而且使用者看不到任何可行動的說明。實際有三條獨立的失敗路徑：

1. **超過 10MB**：`src/app/api/upload/route.ts` 回 `{"error":"file too large"}`（英文原字串）。
   前端有接，但只有一個共用的錯誤區塊掛在整張表單最底下
   （`RegisterForm.tsx:367`），而大頭照的 input 在成員區塊（`:224`）——訊息出現在
   幾百 px 外的頁尾，使用者眼裡就是「按了沒反應」。
2. **HEIC/HEIF**：`accept` 只列 jpeg/png/webp/pdf，iPhone 的 HEIC 被檔案選擇器直接
   過濾掉，`onChange` 根本不觸發。這是 100% 靜默、完全無回饋的路徑。
3. **主機 nginx**：`client_max_body_size` 預設 1M，超過就在 nginx 層 413，
   進不到 Next（見 `docs/ONBOARDING.md:719`）。回應不是 JSON，前端只顯示
   「上傳失敗（413）」。

此外，表單事前完全沒有提示單檔上限。

## 方案

前端在送出前自動壓縮圖片，並補齊三條路徑的引導。

**為什麼不做伺服器端壓縮（sharp）**：不對症。瓶頸在請求送出**之前**——nginx 的
`client_max_body_size` 與路由的 Content-Length 提早檢查（`route.ts` 讀 body 前就 413）
都攔在伺服器拿到 bytes 之前，伺服器沒有機會壓。還要多一顆 native 相依與主機記憶體。

**為什麼不只補引導、不壓縮**：等於把問題丟回給使用者（「請自己縮圖」），
手機上沒有好的操作方式，實際等於沒解。

## 壓縮策略

新增 `src/lib/image-compress.ts`，拆兩層。

### 決策層（純函式，可測）

`planCompression({ kind, mime, size, filename })` → `{ action: "skip" | "compress" | "reject", maxEdge?, quality?, reason? }`

| 情境 | action | 參數 |
| --- | --- | --- |
| `kind=photo` ＋ 圖片 MIME | `compress` | `maxEdge: 1024` |
| `kind=attachment` ＋ 圖片 ＋ `size <= 10MB` | `skip` | 原檔直上，品質不動 |
| `kind=attachment` ＋ 圖片 ＋ 超標 | `compress` | `maxEdge: 2400` |
| `application/pdf` ＋ 超標 | `reject` | reason：PDF 無法自動壓縮，請改用手機直接拍照上傳 |
| `application/pdf` ＋ 未超標 | `skip` | |
| HEIC / HEIF | `compress` | Safari 解得了；解碼失敗由執行層降級成 reject |
| 未知 MIME | `skip` | 交給伺服器白名單擋，前端不重複判斷 |

HEIC 的判定不能只看 MIME：部分瀏覽器對 `.heic` 給的 `file.type` 是空字串。
`planCompression` 因此同時吃檔名，副檔名為 `.heic` / `.heif` 時一律視為 HEIC 走
`compress`，不要落到「未知 MIME → skip」那格——否則伺服器會回 415，
使用者看到的是「只接受 JPG／PNG／WebP」而不是 HEIC 專屬引導。

大頭照一律壓（即使小檔）是刻意的：它只用於候選卡片與選票顯示，長邊 1024 綽綽有餘，
不需要原圖。若日後有列印票或大圖需求，此數字要往上調。

學生證只在超標時才壓、且保守（長邊 2400、q0.85 起跳）是刻意的：管理員審核時要看清
學號、姓名、相片，壓過頭就審不了。

### 執行層（薄，不寫測試）

`compressImage(file, plan)`：

- decode：`createImageBitmap(file, { imageOrientation: "from-image" })`
  （`from-image` 必須帶，否則 iPhone 直拍的照片會轉 90 度）
- 等比縮放至長邊不超過 `maxEdge`，**只縮不放**
- 白底填充後再 draw（透明 PNG 轉 JPEG 才不會變黑底）
- `canvas.toBlob("image/jpeg", q)`，品質階梯 0.85 → 0.7 → 0.6，壓到低於上限為止
- 壓完比原檔大 → 退回原檔
- `createImageBitmap` 不支援或解碼失敗 → 退回原檔（讓伺服器照原本規則判）；
  HEIC 解碼失敗則回 HEIC 專屬引導
- 檔名副檔名跟著換成 `.jpg`

## UI 與錯誤引導

全部在 `src/components/public/RegisterForm.tsx`。

### (a) 錯誤訊息就近顯示

大頭照錯誤存進 `photoErrors: Record<number, string>`，渲染在該成員的照片 input 正下方；
附件錯誤存 `attachmentError`，渲染在上傳按鈕下方。表單底部既有的 `error` 只留給送出失敗。

### (b) 事前提示

- 照片 input 旁：「JPG／PNG／WebP，過大會自動壓縮」
- 附件旁：「JPG／PNG／WebP／PDF，單檔 10MB；圖片過大會自動壓縮，PDF 不會」

### (c) 錯誤訊息中文化

前端持有一張對照表把伺服器的 error code 轉成中文可行動句子。**不改伺服器回中文**——
那些字串是 API 契約，`tests/` 裡有斷言在對它們。

| 伺服器回應 | 顯示 |
| --- | --- |
| `file too large` | 檔案超過 10MB，且自動壓縮後仍過大，請改拍解析度低一點的照片 |
| `file type not allowed` | 只接受 JPG／PNG／WebP（附件另收 PDF） |
| `upload quota exceeded` | 這場選舉的上傳次數已達上限（20 個檔），請先移除不需要的附件 |
| 413 但 body 非 JSON | 檔案過大，被伺服器擋下（提示這是主機設定問題） |
| 其他 | 保留原本的 `上傳失敗（${status}）` |

### (d) HEIC 路徑

`accept` 加上 `image/heic,image/heif,.heic,.heif`。目的不是支援它，是**讓使用者選得到檔**
——現在選不到，`onChange` 根本不觸發，才會完全靜默。選到之後 Safari 能解就正常壓縮上傳；
Chrome／Android 解不了則顯示：

> 這是 iPhone 的 HEIC 格式，此瀏覽器無法處理。請到 iPhone 設定 → 相機 → 格式 →
> 選「最相容」後重拍，或改用 Safari 上傳。

### (e) 壓縮中狀態

沿用既有的 `photoUploading` / `uploading`，文案在壓縮階段顯示「壓縮中…」、上傳階段
「上傳中…」。大檔壓縮在手機上要數秒，沒有這個回饋一樣像當掉。

## 不動的東西

伺服器端 `src/app/api/upload/route.ts` 完全不改：10MB 上限、Content-Length 提早檢查、
MIME 白名單、magic bytes 驗證全部維持。**前端壓縮是 UX，不是安全邊界。**

## 測試

`tests/image-compress.test.ts`（與其他純函式測試同層，`vitest.config.ts` 的
`include: ["tests/*.test.ts"]` 直接吃得到，不用改設定）。只測決策層：

- `photo` ＋ 小圖 → 仍然 `compress`（釘住「公開顯示一律壓」這個刻意決策）
- `attachment` ＋ 9MB JPEG → `skip`（釘住「10MB 以下品質不動」這個核心承諾）
- `attachment` ＋ 12MB JPEG → `compress`，`maxEdge: 2400`
- `attachment` ＋ 12MB PDF → `reject`，reason 提到「拍照」
- `attachment` ＋ 3MB PDF → `skip`
- HEIC / HEIF MIME → `compress`
- 未知 MIME → `skip`
- `file.type` 為空字串但檔名是 `.heic` → `compress`（不可落進 skip）

執行層（canvas 編碼）不寫測試：jsdom 沒有真的 canvas 編碼器，測出來的只是 mock 在對
自己說話。品質階梯若要測，把「下一個要試的 quality」抽成純函式一起測。

驗證：`pnpm exec tsc --noEmit`、`pnpm lint`、`pnpm test`。

## 檔案清單

| 檔案 | 動作 |
| --- | --- |
| `src/lib/image-compress.ts` | 新增（決策層＋執行層＋錯誤訊息對照表） |
| `tests/image-compress.test.ts` | 新增 |
| `src/components/public/RegisterForm.tsx` | 改 |
| `src/app/api/upload/route.ts` | 不動 |

## 範圍外：主機 nginx

T-Vote 註冊表仍是 `deployed:false`，主機的 nginx server block 大概率還沒設
`client_max_body_size`（預設 1M）。壓縮後的大頭照多半碰不到，但學生證的 `skip` 路徑
（9MB 原檔直上）在沒設好的主機上會 413。

**上線前需要有 root 的人在主機上執行**（agent 拿不到 root）：在
`/etc/nginx/sites-enabled/vote.tschoolsu.org` 的 server block 加
`client_max_body_size 21M;`，然後 `nginx -t && systemctl reload nginx`。

⚠️ 位置是 **`listen 80` 那個 block**，不是 443——這台主機的 TLS 由 Cloudflare 終結，
nginx 只聽 80。`docs/ONBOARDING.md:321` 寫的「443 的 server block」對這台不適用。
照 `form.tschoolsu.org` 的擺法：放在 `server_name` 下面、log 設定之前。

2026-09-08 實查：全主機只有 `form.tschoolsu.org` 有這行，`vote.tschoolsu.org` **沒有**。

驗證（不需登入）：

```
curl -s -o /dev/null -w '%{http_code}' -F file=@<2MB的檔> https://vote.tschoolsu.org/api/upload
```

回 401（進到 Next）而不是 413 就對了。

不在這次實作範圍。

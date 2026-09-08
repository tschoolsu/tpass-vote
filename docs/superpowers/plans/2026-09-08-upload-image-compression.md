# 登記上傳圖片自動壓縮與失敗引導 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 候選人登記表單的大頭照與學生證影本在送出前於瀏覽器自動壓縮，並讓所有壓不了的失敗情境都有就近、中文、可行動的說明。

**Architecture:** 新增 `src/lib/image-compress.ts`，分成可測的純函式決策層（`planCompression` / `scaledSize` / `jpegName` / `uploadErrorMessage`）與薄薄一層 canvas 執行層（`prepareUpload`）。`RegisterForm.tsx` 在 `fetch("/api/upload")` 之前呼叫 `prepareUpload`，把錯誤顯示在對應的 input 旁邊。伺服器端完全不動。

**Tech Stack:** Next 16.3 + React 19（client component）、TypeScript、Vitest（純函式）、瀏覽器原生 `createImageBitmap` / `<canvas>.toBlob`，**不加任何新相依**。

## Global Constraints

- 套件管理一律 pnpm。**這個計畫不新增任何相依**，不要 `pnpm add` 任何東西。
- 伺服器端 `src/app/api/upload/route.ts` **一行都不能改**。前端壓縮是 UX，不是安全邊界；上限、MIME 白名單、magic bytes 驗證全部維持原樣。
- 伺服器的英文 error 字串（`"file too large"` / `"file type not allowed"` / `"upload quota exceeded"`）是 API 契約，**不要改成中文**，翻譯在前端做。
- 單檔上限 `10 * 1024 * 1024`（與 `route.ts` 的 `MAX_UPLOAD_BYTES` 一致）。
- 大頭照長邊上限 `1024`；學生證影本長邊上限 `2400`；品質階梯 `[0.85, 0.7, 0.6]`。
- 純函式測試放 `tests/*.test.ts`（`vitest.config.ts` 的 `include` 只吃這一層），跑 `pnpm test`。
- UI 一律 light-only Neobrutalism + OKLCH，元件 import 自 `tpass-ui`；**不要寫 hex／rgb 顏色、不要寫 `dark:`**，用既有的 `text-destructive` / `text-muted-foreground` 這類 token class。
- 專案用 Next 16 + React 19，API 可能與訓練資料不同。要查 Next 行為請讀 `node_modules/next/dist/docs/`。
- 每個 task 結束前跑 `pnpm exec tsc --noEmit` 與 `pnpm lint`，兩者都要乾淨才 commit。
- commit 訊息用繁體中文，格式照既有 git log（`feat(...)`: / `fix(...)`: / `docs(...)`:）。

---

### Task 1: 決策層純函式 `planCompression`

決定「這個檔要不要壓、壓到多大、還是直接擋下來」。全部是純函式，不碰 DOM、不碰 File 物件（只吃 mime / size / filename 三個原始值），所以可以完整測。

**Files:**
- Create: `src/lib/image-compress.ts`
- Test: `tests/image-compress.test.ts`

**Interfaces:**
- Consumes: 無（第一個 task）
- Produces:
  - `type UploadKind = "attachment" | "photo"`
  - `interface CompressionPlan { action: "skip" | "compress" | "reject"; maxEdge?: number; quality?: number; reason?: string }`
  - `function planCompression(input: { kind: UploadKind; mime: string; size: number; filename: string }): CompressionPlan`
  - `function isHeic(input: { mime: string; filename: string }): boolean`
  - `const MAX_UPLOAD_BYTES = 10 * 1024 * 1024`
  - `const PHOTO_MAX_EDGE = 1024`
  - `const ATTACHMENT_MAX_EDGE = 2400`
  - `const QUALITY_LADDER = [0.85, 0.7, 0.6] as const`
  - `const HEIC_MESSAGE: string`
  - `const PDF_TOO_LARGE_MESSAGE: string`
  - `const STILL_TOO_LARGE_MESSAGE: string`

- [ ] **Step 1: Write the failing test**

建立 `tests/image-compress.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  planCompression,
  isHeic,
  MAX_UPLOAD_BYTES,
  PHOTO_MAX_EDGE,
  ATTACHMENT_MAX_EDGE,
} from "@/lib/image-compress";

const MB = 1024 * 1024;

describe("planCompression", () => {
  it("大頭照即使是小圖也要壓：公開顯示不需要原圖，尺寸統一才不會有人塞 4000px 進選票", () => {
    const plan = planCompression({
      kind: "photo",
      mime: "image/jpeg",
      size: 200 * 1024,
      filename: "me.jpg",
    });
    expect(plan.action).toBe("compress");
    expect(plan.maxEdge).toBe(PHOTO_MAX_EDGE);
  });

  it("學生證 10MB 以內原檔直上，不動品質：管理員要看清學號", () => {
    const plan = planCompression({
      kind: "attachment",
      mime: "image/jpeg",
      size: 9 * MB,
      filename: "card.jpg",
    });
    expect(plan.action).toBe("skip");
  });

  it("學生證超過上限才壓，且用比較大的長邊保住可讀性", () => {
    const plan = planCompression({
      kind: "attachment",
      mime: "image/jpeg",
      size: 12 * MB,
      filename: "card.jpg",
    });
    expect(plan.action).toBe("compress");
    expect(plan.maxEdge).toBe(ATTACHMENT_MAX_EDGE);
  });

  it("剛好等於上限算沒超過", () => {
    const plan = planCompression({
      kind: "attachment",
      mime: "image/jpeg",
      size: MAX_UPLOAD_BYTES,
      filename: "card.jpg",
    });
    expect(plan.action).toBe("skip");
  });

  it("超大 PDF 壓不了，直接擋下並引導改用拍照", () => {
    const plan = planCompression({
      kind: "attachment",
      mime: "application/pdf",
      size: 12 * MB,
      filename: "card.pdf",
    });
    expect(plan.action).toBe("reject");
    expect(plan.reason).toContain("拍照");
  });

  it("小 PDF 照常直上", () => {
    const plan = planCompression({
      kind: "attachment",
      mime: "application/pdf",
      size: 3 * MB,
      filename: "card.pdf",
    });
    expect(plan.action).toBe("skip");
  });

  it("HEIC 走壓縮（Safari 解得了），解不了是執行層的事", () => {
    const plan = planCompression({
      kind: "photo",
      mime: "image/heic",
      size: 3 * MB,
      filename: "IMG_0001.HEIC",
    });
    expect(plan.action).toBe("compress");
  });

  it("file.type 是空字串但副檔名是 .heic 也要當 HEIC，不可落進 skip", () => {
    const plan = planCompression({
      kind: "attachment",
      mime: "",
      size: 3 * MB,
      filename: "IMG_0002.heic",
    });
    expect(plan.action).toBe("compress");
  });

  it("未知 MIME 交給伺服器白名單擋，前端不重複判斷", () => {
    const plan = planCompression({
      kind: "attachment",
      mime: "application/zip",
      size: 1 * MB,
      filename: "stuff.zip",
    });
    expect(plan.action).toBe("skip");
  });
});

describe("isHeic", () => {
  it("認 MIME", () => {
    expect(isHeic({ mime: "image/heif", filename: "x" })).toBe(true);
  });
  it("認副檔名且不分大小寫", () => {
    expect(isHeic({ mime: "", filename: "IMG.HEIC" })).toBe(true);
  });
  it("不誤判一般圖片", () => {
    expect(isHeic({ mime: "image/jpeg", filename: "a.jpg" })).toBe(false);
  });
  it("不因為檔名中間有 heic 字樣就誤判", () => {
    expect(isHeic({ mime: "image/jpeg", filename: "heic-note.jpg" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/image-compress.test.ts`
Expected: FAIL，錯誤是找不到模組 `@/lib/image-compress`。

- [ ] **Step 3: Write minimal implementation**

建立 `src/lib/image-compress.ts`：

```ts
// 登記表單上傳前的瀏覽器端圖片壓縮。分兩層：
//   決策層（本檔上半，純函式）決定要不要壓、壓多大、還是直接擋；
//   執行層（下半，碰 canvas）負責真的解碼、縮放、重新編碼。
// 決策層刻意不吃 File 物件，只吃 mime/size/filename 三個原始值，這樣測得動。
//
// ⚠️ 這裡的一切都是 UX，不是安全邊界。單檔上限、MIME 白名單、magic bytes 驗證
// 一律以 src/app/api/upload/route.ts 為準，前端擋不掉的伺服器照樣會擋。

export type UploadKind = "attachment" | "photo";

export interface CompressionPlan {
  action: "skip" | "compress" | "reject";
  /** 壓縮後長邊的上限（px）。只在 action === "compress" 時有值。 */
  maxEdge?: number;
  /** 第一輪嘗試的 JPEG 品質。只在 action === "compress" 時有值。 */
  quality?: number;
  /** 給使用者看的中文說明。只在 action === "reject" 時有值。 */
  reason?: string;
}

/** 與 src/app/api/upload/route.ts 的 MAX_UPLOAD_BYTES 同值，改一邊要改兩邊。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 大頭照只用於候選卡與選票顯示，長邊 1024 綽綽有餘。若日後要列印票再往上調。 */
export const PHOTO_MAX_EDGE = 1024;
/** 學生證影本要讓管理員看清學號姓名，長邊給得比大頭照寬鬆很多。 */
export const ATTACHMENT_MAX_EDGE = 2400;
/** 由高到低試，第一個壓進上限的就用。 */
export const QUALITY_LADDER = [0.85, 0.7, 0.6] as const;

export const HEIC_MESSAGE =
  "這是 iPhone 的 HEIC 格式，此瀏覽器無法處理。請到 iPhone 設定 → 相機 → 格式 → 選「最相容」後重拍，或改用 Safari 上傳。";
export const PDF_TOO_LARGE_MESSAGE =
  "PDF 超過 10MB 且無法自動壓縮，請改用手機直接拍照上傳。";
export const STILL_TOO_LARGE_MESSAGE =
  "檔案太大，自動壓縮後仍超過 10MB，請改拍解析度低一點的照片。";

const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"];
const HEIC_MIME = ["image/heic", "image/heif"];

/**
 * 部分瀏覽器對 .heic 給的 file.type 是空字串，所以 MIME 與副檔名都要看。
 * 沒有這一條，HEIC 會落進「未知 MIME → skip」，使用者拿到的是伺服器的
 * 415「只接受 JPG／PNG／WebP」，而不是「請改用最相容格式」的專屬引導。
 */
export function isHeic({ mime, filename }: { mime: string; filename: string }): boolean {
  if (HEIC_MIME.includes(mime)) return true;
  return /\.(heic|heif)$/i.test(filename);
}

export function planCompression({
  kind,
  mime,
  size,
  filename,
}: {
  kind: UploadKind;
  mime: string;
  size: number;
  filename: string;
}): CompressionPlan {
  const maxEdge = kind === "photo" ? PHOTO_MAX_EDGE : ATTACHMENT_MAX_EDGE;
  const quality = QUALITY_LADDER[0];

  if (isHeic({ mime, filename })) {
    return { action: "compress", maxEdge, quality };
  }

  if (mime === "application/pdf") {
    return size > MAX_UPLOAD_BYTES
      ? { action: "reject", reason: PDF_TOO_LARGE_MESSAGE }
      : { action: "skip" };
  }

  if (IMAGE_MIME.includes(mime)) {
    // 大頭照一律壓：它會被公開顯示，尺寸統一比保留原圖重要。
    if (kind === "photo") return { action: "compress", maxEdge, quality };
    // 學生證只在超標時才壓，10MB 以內原封不動送出，保住學號可讀性。
    return size > MAX_UPLOAD_BYTES
      ? { action: "compress", maxEdge, quality }
      : { action: "skip" };
  }

  // 認不得的類型不在前端判死，交給伺服器白名單，錯誤訊息由 uploadErrorMessage 翻譯。
  return { action: "skip" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/image-compress.test.ts`
Expected: PASS，13 個 test 全綠。

- [ ] **Step 5: 型別與 lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 兩個都沒有輸出錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/lib/image-compress.ts tests/image-compress.test.ts
git commit -m "feat(upload): 加上傳圖片壓縮的決策層純函式

大頭照一律壓（長邊 1024），學生證只在超過 10MB 時才壓（長邊 2400），
PDF 超標直接擋並引導改拍照。HEIC 同時看 MIME 與副檔名，因為部分瀏覽器
給的 file.type 是空字串，漏掉會讓使用者拿到「只接受 JPG/PNG/WebP」這種
牛頭不對馬嘴的訊息。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EcYRGyVKkxmM5BXgAUW4ET"
```

---

### Task 2: 伺服器錯誤訊息翻譯 `uploadErrorMessage`

把 `/api/upload` 回的英文 code 翻成中文可行動句子。獨立成一個純函式，因為它有一個容易寫錯的分支：伺服器有些錯誤（例如階段不開放上傳）**本來就回中文**，不能被「未知 code → 上傳失敗（403）」蓋掉。

**Files:**
- Modify: `src/lib/image-compress.ts`（追加在檔案末尾的決策層區塊）
- Test: `tests/image-compress.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `STILL_TOO_LARGE_MESSAGE`
- Produces: `function uploadErrorMessage(status: number, code: string | null): string`

- [ ] **Step 1: Write the failing test**

在 `tests/image-compress.test.ts` 的 import 加入 `uploadErrorMessage`，並在檔案末尾追加：

```ts
describe("uploadErrorMessage", () => {
  it("翻譯 file too large 並給下一步", () => {
    const msg = uploadErrorMessage(413, "file too large");
    expect(msg).toContain("10MB");
    expect(msg).not.toContain("file too large");
  });

  it("翻譯 file type not allowed", () => {
    expect(uploadErrorMessage(415, "file type not allowed")).toContain("JPG");
  });

  it("翻譯 upload quota exceeded 並講清楚怎麼解", () => {
    const msg = uploadErrorMessage(429, "upload quota exceeded");
    expect(msg).toContain("上限");
    expect(msg).toContain("移除");
  });

  it("413 但拿不到 JSON body（nginx 擋掉）要講是伺服器設定", () => {
    const msg = uploadErrorMessage(413, null);
    expect(msg).toContain("伺服器");
  });

  it("伺服器本來就回中文的錯誤要原樣顯示，不可被通用訊息蓋掉", () => {
    const msg = uploadErrorMessage(403, "這場選舉目前的階段不開放上傳");
    expect(msg).toBe("這場選舉目前的階段不開放上傳");
  });

  it("認不得的英文 code 退回帶狀態碼的通用訊息", () => {
    expect(uploadErrorMessage(500, "boom")).toBe("上傳失敗（500）");
  });

  it("完全沒有 body 時也退回通用訊息", () => {
    expect(uploadErrorMessage(502, null)).toBe("上傳失敗（502）");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/image-compress.test.ts`
Expected: FAIL，`uploadErrorMessage is not a function` 或 import 找不到該名稱。

- [ ] **Step 3: Write minimal implementation**

在 `src/lib/image-compress.ts` 的 `planCompression` 之後追加：

```ts
/**
 * /api/upload 的錯誤 code 是英文字串（API 契約，tests/ 有斷言在對它們），
 * 直接丟到畫面上等於沒說。這裡翻成使用者能照做的中文。
 *
 * ⚠️ 有些錯誤伺服器本來就回中文（例如階段不開放上傳），那種要原樣顯示——
 * 用「含非 ASCII 就當作已經是給人看的訊息」來分辨，別讓通用訊息蓋掉它。
 */
export function uploadErrorMessage(status: number, code: string | null): string {
  switch (code) {
    case "file too large":
      return STILL_TOO_LARGE_MESSAGE;
    case "file type not allowed":
      return "只接受 JPG／PNG／WebP（學生證影本另收 PDF）。";
    case "upload quota exceeded":
      return "這場選舉的上傳次數已達上限（20 個檔），請先移除不需要的附件。";
  }

  // nginx 在 Next 之前就 413 掉的情況：回的是 HTML，解不出 code。
  if (status === 413) {
    return "檔案過大，被伺服器擋下。這是主機設定問題，請聯絡選委會。";
  }

  // 用「含非 ASCII 字元」判斷這段是不是本來就寫給人看的中文。
  // 不用 /[^\x00-\x7F]/ 這種寫法：正規式裡的控制字元會被 eslint 的
  // no-control-regex 擋下來。
  if (code && [...code].some((ch) => (ch.codePointAt(0) ?? 0) > 127)) return code;

  return `上傳失敗（${status}）`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/image-compress.test.ts`
Expected: PASS，全部 20 個 test 綠。

- [ ] **Step 5: 型別與 lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 乾淨。

- [ ] **Step 6: Commit**

```bash
git add src/lib/image-compress.ts tests/image-compress.test.ts
git commit -m "feat(upload): 把伺服器的英文上傳錯誤翻成可行動的中文

伺服器那些字串是 API 契約不能改，所以翻譯放前端。特別留一條：
伺服器有些錯誤本來就回中文（階段不開放上傳），不可被「上傳失敗（403）」
這種通用訊息蓋掉。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EcYRGyVKkxmM5BXgAUW4ET"
```

---

### Task 3: 執行層 `prepareUpload`

真正做解碼、縮放、重新編碼的一層。`scaledSize` 與 `jpegName` 是純函式，測；碰 canvas 的 `prepareUpload` 不測——jsdom 沒有真的 canvas 編碼器，測出來只是 mock 在對自己說話。

**Files:**
- Modify: `src/lib/image-compress.ts`
- Test: `tests/image-compress.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `planCompression` / `isHeic` / `MAX_UPLOAD_BYTES` / `QUALITY_LADDER` / `HEIC_MESSAGE` / `STILL_TOO_LARGE_MESSAGE`
- Produces:
  - `type PrepareResult = { ok: true; file: File; compressed: boolean } | { ok: false; message: string }`
  - `async function prepareUpload(file: File, kind: UploadKind): Promise<PrepareResult>`
  - `function scaledSize(width: number, height: number, maxEdge: number): { width: number; height: number }`
  - `function jpegName(name: string): string`

- [ ] **Step 1: Write the failing test**

在 `tests/image-compress.test.ts` 的 import 加入 `scaledSize` 與 `jpegName`，並追加：

```ts
describe("scaledSize", () => {
  it("長邊超過上限就等比縮", () => {
    expect(scaledSize(4000, 3000, 1024)).toEqual({ width: 1024, height: 768 });
  });

  it("直式照片以高為長邊", () => {
    expect(scaledSize(3000, 4000, 1024)).toEqual({ width: 768, height: 1024 });
  });

  it("只縮不放：比上限小的圖維持原尺寸", () => {
    expect(scaledSize(600, 400, 1024)).toEqual({ width: 600, height: 400 });
  });

  it("剛好等於上限不動", () => {
    expect(scaledSize(1024, 512, 1024)).toEqual({ width: 1024, height: 512 });
  });

  it("縮完不會出現 0：極端長條圖至少留 1px", () => {
    expect(scaledSize(10000, 3, 1024).height).toBeGreaterThanOrEqual(1);
  });
});

describe("jpegName", () => {
  it("換掉原副檔名", () => {
    expect(jpegName("IMG_0001.HEIC")).toBe("IMG_0001.jpg");
  });

  it("沒有副檔名就直接接上", () => {
    expect(jpegName("scan")).toBe("scan.jpg");
  });

  it("只換最後一段，檔名中的點不動", () => {
    expect(jpegName("2026.09.08 學生證.png")).toBe("2026.09.08 學生證.jpg");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/image-compress.test.ts`
Expected: FAIL，`scaledSize`／`jpegName` 不存在。

- [ ] **Step 3: Write minimal implementation**

在 `src/lib/image-compress.ts` 末尾追加執行層：

```ts
// ── 執行層：以下開始碰 DOM，只在瀏覽器跑 ──────────────────────────────

export type PrepareResult =
  | { ok: true; file: File; compressed: boolean }
  | { ok: false; message: string };

/** 等比縮到長邊不超過 maxEdge。只縮不放；最短邊至少留 1px，避免產生 0 寬高的 canvas。 */
export function scaledSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** 壓縮輸出一律是 JPEG，檔名副檔名要跟著換，不然清單上顯示 .heic 會誤導。 */
export function jpegName(name: string): string {
  return `${name.replace(/\.[^./\\]*$/, "")}.jpg`;
}

function toJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/**
 * 上傳前處理單一檔案。回傳的 file 直接丟進 FormData 送 /api/upload。
 *
 * 失敗一律回 { ok: false, message }，message 是可以直接顯示給使用者的中文。
 * 遇到解不動又不確定原因的情況，選擇退回原檔而不是報錯——讓伺服器用它原本
 * 那套規則判，比前端猜錯把合法檔案擋掉好。
 */
export async function prepareUpload(file: File, kind: UploadKind): Promise<PrepareResult> {
  const plan = planCompression({
    kind,
    mime: file.type,
    size: file.size,
    filename: file.name,
  });

  if (plan.action === "reject") {
    return { ok: false, message: plan.reason ?? STILL_TOO_LARGE_MESSAGE };
  }
  if (plan.action === "skip") return { ok: true, file, compressed: false };

  const maxEdge = plan.maxEdge ?? PHOTO_MAX_EDGE;

  let bitmap: ImageBitmap;
  try {
    // imageOrientation 一定要帶 from-image，否則 iPhone 直拍的照片會轉 90 度。
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Chrome／Android 解不了 HEIC，這條要給專屬引導，不能讓它變成一句「上傳失敗」。
    if (isHeic({ mime: file.type, filename: file.name })) {
      return { ok: false, message: HEIC_MESSAGE };
    }
    // 其他解碼失敗（含瀏覽器根本沒有 createImageBitmap）退回原檔交給伺服器判。
    return { ok: true, file, compressed: false };
  }

  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height, maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: true, file, compressed: false };

    // 透明 PNG 直接轉 JPEG 會變黑底，先鋪白再畫。
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    for (const quality of QUALITY_LADDER) {
      const blob = await toJpegBlob(canvas, quality);
      if (!blob) break;
      if (blob.size > MAX_UPLOAD_BYTES) continue;
      // 壓完反而變大（本來就很小、已優化過的圖會這樣）就用原檔，別越幫越忙。
      if (blob.size >= file.size) return { ok: true, file, compressed: false };
      return {
        ok: true,
        file: new File([blob], jpegName(file.name), { type: "image/jpeg" }),
        compressed: true,
      };
    }

    return { ok: false, message: STILL_TOO_LARGE_MESSAGE };
  } finally {
    bitmap.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/image-compress.test.ts`
Expected: PASS，全部 28 個 test 綠。

- [ ] **Step 5: 型別與 lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 乾淨。兩個可能的絆腳石：

- 若 `#ffffff` 觸發專案的顏色檢查——那是 canvas 的繪圖 API 不是 CSS，加一行
  `// canvas 繪圖色，不是 CSS token 的適用範圍` 說明即可。
- 若 tsc 抱怨 `imageOrientation: "from-image"` 不在 `ImageBitmapOptions` 裡，代表
  lib.dom 版本太舊。**不要用 `as any` 蓋掉**——那個選項是防 iPhone 照片轉 90 度的關鍵，
  型別對不上就是環境有問題。先確認 `pnpm exec tsc --version` 是 5.x，再回報。

- [ ] **Step 6: Commit**

```bash
git add src/lib/image-compress.ts tests/image-compress.test.ts
git commit -m "feat(upload): 加 canvas 壓縮執行層 prepareUpload

createImageBitmap 帶 imageOrientation: from-image（不帶的話 iPhone 直拍
照片會轉 90 度）、轉 JPEG 前鋪白底（不鋪的話透明 PNG 會變黑）、品質階梯
0.85→0.7→0.6、壓完比原檔大就退回原檔。解碼失敗時 HEIC 給專屬引導，
其餘退回原檔讓伺服器照原本規則判。

canvas 編碼那層不寫測試：jsdom 沒有真的編碼器，測到的只是 mock 自己。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EcYRGyVKkxmM5BXgAUW4ET"
```

---

### Task 4: RegisterForm 接線與 UI

把壓縮接進兩個上傳 handler，並把錯誤訊息從表單頁尾搬到操作點旁邊。

**背景（實作者必讀）：** 目前 `RegisterForm.tsx` 只有一個 `error` state，渲染在整張表單最底下（約 `:367`）。大頭照的 input 在成員 Card 裡（約 `:224`），失敗訊息出現在幾百 px 外，使用者眼裡就是「按了沒反應」——這是這次要修的核心體驗問題，比壓縮本身更重要。

**Files:**
- Modify: `src/components/public/RegisterForm.tsx`

**Interfaces:**
- Consumes: Task 3 的 `prepareUpload`、Task 2 的 `uploadErrorMessage`
- Produces: 無（終端 task）

- [ ] **Step 1: 換掉上傳中的 state 型別**

`RegisterForm.tsx` 目前用兩個布林表示忙碌。壓縮階段在手機上要好幾秒，沒有區隔的話一樣像當掉，所以改成三態。

在 `interface AttachmentFile` 附近加型別：

```ts
/** 上傳的兩個階段。壓縮在手機上要數秒，跟上傳分開顯示才不會讓人以為當掉。 */
type UploadPhase = "compressing" | "uploading";
```

把 state 宣告（約 `:45-51`）：

```ts
  const [uploading, setUploading] = React.useState(false);
  const [photoUploading, setPhotoUploading] = React.useState<Record<number, boolean>>({});
```

換成：

```ts
  const [attachmentPhase, setAttachmentPhase] = React.useState<UploadPhase | null>(null);
  const [photoPhase, setPhotoPhase] = React.useState<Record<number, UploadPhase | null>>({});
  const [attachmentError, setAttachmentError] = React.useState<string | null>(null);
  const [photoErrors, setPhotoErrors] = React.useState<Record<number, string | null>>({});
```

- [ ] **Step 2: 加入 import**

檔案頂端 import 區加：

```ts
import { prepareUpload, uploadErrorMessage } from "@/lib/image-compress";
```

- [ ] **Step 3: 改寫 `handleMemberPhoto`**

整個函式（約 `:57-80`）換成：

```ts
  async function handleMemberPhoto(idx: number, file: File | null) {
    if (!file) return;
    setPhotoErrors((prev) => ({ ...prev, [idx]: null }));
    setPhotoPhase((prev) => ({ ...prev, [idx]: "compressing" }));
    try {
      const prepared = await prepareUpload(file, "photo");
      if (!prepared.ok) {
        setPhotoErrors((prev) => ({ ...prev, [idx]: prepared.message }));
        return;
      }
      setPhotoPhase((prev) => ({ ...prev, [idx]: "uploading" }));
      const form = new FormData();
      form.set("file", prepared.file);
      form.set("electionId", electionId);
      form.set("kind", "photo");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setPhotoErrors((prev) => ({
          ...prev,
          [idx]: uploadErrorMessage(res.status, body?.error ?? null),
        }));
        return;
      }
      const uploaded = (await res.json()) as { id: string };
      setMembers((prev) => prev.map((m, i) => (i === idx ? { ...m, photo: uploaded.id } : m)));
    } catch {
      // 網路層直接斷掉（含 nginx reset）走這裡，拿不到狀態碼。
      setPhotoErrors((prev) => ({ ...prev, [idx]: "大頭照上傳失敗，請檢查網路後再試一次。" }));
    } finally {
      setPhotoPhase((prev) => ({ ...prev, [idx]: null }));
      const input = photoInputRefs.current[idx];
      if (input) input.value = "";
    }
  }
```

- [ ] **Step 4: 改寫 `handleFiles`**

整個函式（約 `:86-108`）換成：

```ts
  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setAttachmentError(null);
    try {
      for (const file of Array.from(files)) {
        setAttachmentPhase("compressing");
        const prepared = await prepareUpload(file, "attachment");
        if (!prepared.ok) {
          // 多選時其中一個壞掉：講清楚是哪一個，前面已經上傳成功的保留。
          setAttachmentError(`${file.name}：${prepared.message}`);
          return;
        }
        setAttachmentPhase("uploading");
        const form = new FormData();
        form.set("file", prepared.file);
        form.set("electionId", electionId);
        const res = await fetch("/api/upload", { method: "POST", body: form });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setAttachmentError(`${file.name}：${uploadErrorMessage(res.status, body?.error ?? null)}`);
          return;
        }
        const uploaded = (await res.json()) as AttachmentFile;
        setAttachments((prev) => [...prev, uploaded]);
      }
    } catch {
      setAttachmentError("上傳失敗，請檢查網路後再試一次。");
    } finally {
      setAttachmentPhase(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }
```

- [ ] **Step 5: 更新大頭照區塊的 UI**

在成員 Card 內（約 `:216-250`）：

說明文字改成（原本寫「單檔 10MB 以內」，現在會自動壓，講法要跟著改）：

```tsx
              <p className="mt-0.5 text-xs font-medium text-muted-foreground">
                將公開顯示於選票與候選卡。接受 jpg/png/webp/heic，過大會自動壓縮。
              </p>
```

`<input>` 的 `accept` 加上 HEIC。**這一行是修「完全靜默」那條路徑的關鍵**：現在 HEIC 被檔案選擇器過濾掉，`onChange` 根本不觸發，使用者連錯誤都看不到：

```tsx
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
```

按鈕的忙碌判斷與文案：

```tsx
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={photoPhase[idx] != null}
                  onClick={() => photoInputRefs.current[idx]?.click()}
                >
                  {photoPhase[idx] != null ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UploadCloud className="h-4 w-4" />
                  )}
                  {photoPhase[idx] === "compressing"
                    ? "壓縮中…"
                    : photoPhase[idx] === "uploading"
                      ? "上傳中…"
                      : m.photo
                        ? "更換大頭照"
                        : "上傳大頭照"}
                </Button>
```

在那組按鈕的 `</div>`（結束 `mt-1.5 flex gap-2` 那層）之後、`</div>` 收掉右側欄之前，插入就近錯誤：

```tsx
              {photoErrors[idx] && (
                <p role="alert" className="mt-1.5 text-xs font-bold text-destructive">
                  {photoErrors[idx]}
                </p>
              )}
```

- [ ] **Step 6: 更新學生證影本區塊的 UI**

在附件 Card 內（約 `:315-364`）：

說明文字：

```tsx
        <p className="mt-1 text-sm font-medium text-muted-foreground">
          供選委會核對身分，僅開放管理員檢視。接受 jpg/png/webp/heic/pdf，單檔 10MB
          以內；圖片過大會自動壓縮，PDF 不會。
        </p>
```

`accept`：

```tsx
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/pdf"
```

按鈕：

```tsx
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={attachmentPhase != null}
            onClick={() => fileInputRef.current?.click()}
          >
            {attachmentPhase != null ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            {attachmentPhase === "compressing"
              ? "壓縮中…"
              : attachmentPhase === "uploading"
                ? "上傳中…"
                : "選擇檔案上傳"}
          </Button>
```

在那個 `<Button>` 的結尾之後、包住它的 `</div>` 之前，插入就近錯誤：

```tsx
          {attachmentError && (
            <p role="alert" className="mt-2 text-sm font-bold text-destructive">
              {attachmentError}
            </p>
          )}
```

- [ ] **Step 7: 修掉殘留的 `uploading` 參照**

送出按鈕（約 `:373`）原本是 `disabled={submitting || uploading}`，`uploading` 已經不存在，改成：

```tsx
      <Button type="submit" variant="primary" disabled={submitting || attachmentPhase != null}>
```

表單底部那個 `error` 區塊（約 `:367`）**保留不動**——它現在專門給送出失敗（`handleSubmit` 裡的 `setError(result.error)`）用。

Run: `grep -n "uploading\b" src/components/public/RegisterForm.tsx`
Expected: 沒有任何輸出（`photoUploading` / `uploading` 都已消滅）。

- [ ] **Step 8: 型別、lint、全部測試**

Run: `pnpm exec next typegen && pnpm exec tsc --noEmit && pnpm lint && pnpm test`
Expected: 全部乾淨，測試全綠。

- [ ] **Step 9: 手動驗證**

`pnpm dev` 起在背景（`run_in_background: true`，用完關掉），開 `https://vote.lvh.me:3006`，找一場 `registration` 狀態的選舉進登記表單，確認：

1. 上傳一張 >10MB 的 JPEG 當大頭照 → 顯示「壓縮中…」→「上傳中…」→ 成功，圓形預覽出現
2. 上傳一個 >10MB 的 PDF 當學生證 → 按鈕下方立刻出現「PDF 超過 10MB 且無法自動壓縮，請改用手機直接拍照上傳。」，**不會**發出任何網路請求
3. 上傳一張 <10MB 的 JPEG 當學生證 → 直接上傳，DevTools Network 看 request payload 大小與原檔相同（沒被壓）
4. iPhone 直拍的直式照片當大頭照 → 預覽方向正確，沒有轉 90 度

第 4 點需要真的 HEIC/EXIF 檔案；沒有的話明說沒驗到，不要當作通過。

- [ ] **Step 10: Commit**

```bash
git add src/components/public/RegisterForm.tsx
git commit -m "fix(register): 上傳圖片自動壓縮，失敗訊息搬到操作點旁邊

原本整張表單共用一個錯誤區塊掛在頁尾，大頭照上傳失敗時訊息出現在幾百 px
外，使用者眼裡就是按了沒反應。改成每個成員的照片、附件各有自己的錯誤位置。

accept 加上 HEIC：目的不是支援它，是讓使用者選得到檔——現在被檔案選擇器
過濾掉，onChange 根本不觸發，那是唯一 100% 無回饋的路徑。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EcYRGyVKkxmM5BXgAUW4ET"
```

---

## 範圍外：主機 nginx（實作者不要動，但要記得提醒）

spec 的〈範圍外〉一節記著：主機 nginx server block 若沒設 `client_max_body_size`（預設 1M），學生證的 `skip` 路徑（9MB 原檔直上）在正式站會 413。這需要有 root 的人在主機上執行，agent 拿不到 root。

**不要在這個計畫裡嘗試處理它。** 實作完成後在回報中提一句即可，指向
`docs/superpowers/specs/2026-09-08-upload-image-compression-design.md` 的〈範圍外：主機 nginx〉。

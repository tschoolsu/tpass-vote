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
    // 跟上面那條分開講：那條是「副檔名／MIME 宣告的類型」不在白名單裡，
    // 這條是「檔案實際內容」跟宣告的類型對不上（例如把檔名改成 .jpg 但內容其實
    // 不是圖片，或圖檔在傳輸過程中損毀）。原因不同，使用者能做的事也不同。
    case "file content does not match declared type":
      return "這個檔案的內容不是有效的圖片（可能檔案已損毀，或副檔名被改過）。請重新拍照，或另存成 JPG 格式後再上傳一次。";
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

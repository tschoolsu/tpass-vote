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

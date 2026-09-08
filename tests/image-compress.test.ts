import { describe, it, expect } from "vitest";
import {
  planCompression,
  isHeic,
  uploadErrorMessage,
  scaledSize,
  jpegName,
  isServerAcceptedMime,
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

  it("翻譯 file content does not match declared type：要說內容不是有效圖片，且不落進 fallback", () => {
    const msg = uploadErrorMessage(415, "file content does not match declared type");
    expect(msg).toContain("圖片");
    expect(msg).not.toBe("上傳失敗（415）");
  });

  it("401 unauthenticated 刻意不翻譯，走 fallback", () => {
    expect(uploadErrorMessage(401, "unauthenticated")).toBe("上傳失敗（401）");
  });

  it("400 bad request 刻意不翻譯，走 fallback", () => {
    expect(uploadErrorMessage(400, "bad request")).toBe("上傳失敗（400）");
  });

  it("404 election not found 刻意不翻譯，走 fallback", () => {
    expect(uploadErrorMessage(404, "election not found")).toBe("上傳失敗（404）");
  });
});

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

describe("isServerAcceptedMime", () => {
  it("JPEG 收", () => {
    expect(isServerAcceptedMime("image/jpeg")).toBe(true);
  });

  it("PDF 收（學生證影本另收 PDF）", () => {
    expect(isServerAcceptedMime("application/pdf")).toBe(true);
  });

  it("HEIC 不收：退回原檔這條路對它不成立", () => {
    expect(isServerAcceptedMime("image/heic")).toBe(false);
  });

  it("空字串不收", () => {
    expect(isServerAcceptedMime("")).toBe(false);
  });
});

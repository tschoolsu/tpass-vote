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

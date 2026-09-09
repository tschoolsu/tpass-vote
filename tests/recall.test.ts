import { describe, it, expect, afterEach } from "vitest";
import {
  recallThreshold,
  recallPassed,
  canInitiateRecall,
  recallEligibleFrom,
  validateRecallReason,
  RECALL_REASON_MAX_LENGTH,
} from "@/lib/recall";
import { parseDatetimeLocalInTimeZone } from "@/app/admin/elections/election-schema";
import { SITE_TIMEZONE } from "@/config/site";

describe("recallThreshold", () => {
  it("原選舉無有效票 → 門檻為 0", () => {
    expect(recallThreshold(0)).toBe(0);
  });

  it("2/5 整除時取整數", () => {
    expect(recallThreshold(100)).toBe(40);
    expect(recallThreshold(10)).toBe(4);
  });

  it("2/5 非整除時無條件進位", () => {
    expect(recallThreshold(1)).toBe(1); // 0.4 → 1
    expect(recallThreshold(3)).toBe(2); // 1.2 → 2
    expect(recallThreshold(101)).toBe(41); // 40.4 → 41
  });
});

describe("recallPassed", () => {
  it("同意多於不同意 → 通過", () => {
    expect(recallPassed(51, 49)).toBe(true);
  });

  it("同意等於不同意 → 否決", () => {
    expect(recallPassed(50, 50)).toBe(false);
  });

  it("同意少於不同意 → 否決", () => {
    expect(recallPassed(10, 20)).toBe(false);
  });

  it("恰好剛達門檻連署數對應的同意票、無不同意票 → 通過", () => {
    expect(recallPassed(1, 0)).toBe(true);
  });

  it("零票（無人投票）→ 否決", () => {
    expect(recallPassed(0, 0)).toBe(false);
  });
});

describe("canInitiateRecall（§27 就職滿 2 個月硬擋）", () => {
  const started = new Date("2026-01-01T00:00:00Z");

  it("就職日未知（null）→ 不得提起", () => {
    expect(canInitiateRecall(null, new Date())).toBe(false);
  });

  it("未滿 2 個月 → 不得提起", () => {
    expect(canInitiateRecall(started, new Date("2026-02-28T00:00:00Z"))).toBe(false);
  });

  it("恰好滿 2 個月 → 可提起", () => {
    expect(canInitiateRecall(started, recallEligibleFrom(started))).toBe(true);
  });

  it("超過 2 個月 → 可提起", () => {
    expect(canInitiateRecall(started, new Date("2026-06-01T00:00:00Z"))).toBe(true);
  });
});

// startedAt 現在多半來自 offices/actions.ts 的 parseStartedAt，也就是「台北牆上時間的
// 那一天午夜」轉出來的 UTC 瞬間（見 election-schema.ts 的 parseDatetimeLocalInTimeZone）。
// recallEligibleFrom 若用 setMonth() 在 process TZ 的牆上時間加月，正式主機 TZ=UTC 時，
// 台北午夜在 UTC 牆上是前一天 16:00，月加法從前一個月月底起算，遇到月長進位會偏掉
// （方向不定：可能提早開放罷免，也可能延後）。這裡驗證結果只看 SITE_TIMEZONE 的牆上時間，
// 與 server 跑在哪個 process TZ 無關。
describe("recallEligibleFrom（承接 offices 的 startedAt）不依賴 process TZ", () => {
  const ORIGINAL_TZ = process.env.TZ;

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  for (const processTz of ["Etc/UTC", "Asia/Taipei"]) {
    it(`process.env.TZ=${processTz}：就職日台北 2026-03-01 00:00 → 最早可罷免日是台北 2026-05-01 00:00`, () => {
      process.env.TZ = processTz;
      const startedAt = parseDatetimeLocalInTimeZone("2026-03-01T00:00", SITE_TIMEZONE);
      // 台北 2026-04-30 12:00：提早 2 天，不該可提起
      expect(canInitiateRecall(startedAt, new Date("2026-04-30T04:00:00Z"))).toBe(false);
      // 台北 2026-05-01 00:00：滿 2 個月，可提起
      expect(canInitiateRecall(startedAt, new Date("2026-04-30T16:00:00Z"))).toBe(true);
    });

    it(`process.env.TZ=${processTz}：就職日台北 2026-01-01 00:00 → 最早可罷免日是台北 2026-03-01 00:00`, () => {
      process.env.TZ = processTz;
      const startedAt = parseDatetimeLocalInTimeZone("2026-01-01T00:00", SITE_TIMEZONE);
      // 台北 2026-03-01 12:00：滿 2 個月，可提起（不該因 process TZ=UTC 而延後 3 天變成擋下）
      expect(canInitiateRecall(startedAt, new Date("2026-03-01T04:00:00Z"))).toBe(true);
    });
  }
});

// 罷免事由是全站唯一「任一登入師生能寫進 DB、且長度不設限」的欄位（Election.recallReason
// 是 Postgres TEXT，schema 無上限）。next.config.ts 把 serverActions.bodySizeLimit 放寬到
// 8mb 之後，單發就能塞 8MB；每個職務各塞一發，垃圾會永久躺在資料庫裡。
// 其餘公開寫入路徑都已有擋（投票 row lock、連署/登記唯一索引、上傳每人每場 20 檔配額），
// 只有這裡漏掉——上限在這裡定義一次，action 與表單共用。
describe("validateRecallReason", () => {
  it("空字串 → 擋下", () => {
    expect(validateRecallReason("")).toEqual({ ok: false, error: "請填寫罷免事由" });
  });

  it("只有空白 → 擋下（與空字串同一句錯誤）", () => {
    expect(validateRecallReason("   \n\t ")).toEqual({ ok: false, error: "請填寫罷免事由" });
  });

  it("正常事由 → 通過並回傳 trim 過的內容", () => {
    expect(validateRecallReason("  怠忽職守  ")).toEqual({ ok: true, value: "怠忽職守" });
  });

  it("恰好等於上限 → 通過", () => {
    const reason = "字".repeat(RECALL_REASON_MAX_LENGTH);
    expect(validateRecallReason(reason)).toEqual({ ok: true, value: reason });
  });

  it("超過上限 1 字 → 擋下", () => {
    const result = validateRecallReason("字".repeat(RECALL_REASON_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
  });

  it("長度以 trim 後的內容計：前後空白撐到超長不算超長", () => {
    const padded = " ".repeat(5000) + "怠忽職守" + " ".repeat(5000);
    expect(validateRecallReason(padded)).toEqual({ ok: true, value: "怠忽職守" });
  });

  // 以 UTF-16 code unit 計長度時，一個 emoji 算 2，同樣的可見字數會依內容有無 emoji
  // 而給出不同結果。改以碼點計，「幾個字」對使用者是一致的。
  it("長度以碼點計，emoji 算一個字", () => {
    const reason = "🗳".repeat(RECALL_REASON_MAX_LENGTH);
    expect(validateRecallReason(reason).ok).toBe(true);
  });
});

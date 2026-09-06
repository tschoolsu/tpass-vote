// D2-1／D2-2：datetime-local 的解析（parseDatetimeLocalInTimeZone）與回填
// （toDatetimeLocalValue）必須互為反函數，且結果只看牆上時間與 SITE_TIMEZONE，
// 與 server 跑在哪個 process TZ 無關（正式主機是 UTC，開發機常是 Asia/Taipei）。
import { describe, it, expect, afterEach } from "vitest";
import { parseDatetimeLocalInTimeZone, toDatetimeLocalValue } from "@/app/admin/elections/election-schema";
import { SITE_TIMEZONE } from "@/config/site";

const ORIGINAL_TZ = process.env.TZ;

describe("時區：datetime-local 解析／回填不依賴 process TZ", () => {
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  for (const processTz of ["Etc/UTC", "Asia/Taipei"]) {
    it(`process.env.TZ=${processTz} 時，台北 08:00 一律解析成 UTC 00:00`, () => {
      process.env.TZ = processTz;
      const d = parseDatetimeLocalInTimeZone("2026-10-01T08:00", SITE_TIMEZONE);
      expect(d.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    });

    it(`process.env.TZ=${processTz} 時，parse 與回填互為反函數`, () => {
      process.env.TZ = processTz;
      const samples = ["2026-01-01T00:00", "2026-10-01T08:00", "2026-12-31T23:59"];
      for (const s of samples) {
        const parsed = parseDatetimeLocalInTimeZone(s, SITE_TIMEZONE);
        expect(toDatetimeLocalValue(parsed)).toBe(s);
      }
    });
  }

  it("空字串／格式不對回傳無效日期，不丟例外", () => {
    expect(Number.isNaN(parseDatetimeLocalInTimeZone("not-a-date", SITE_TIMEZONE).getTime())).toBe(true);
  });

  it("null／undefined 回填成空字串", () => {
    expect(toDatetimeLocalValue(null)).toBe("");
    expect(toDatetimeLocalValue(undefined)).toBe("");
  });
});

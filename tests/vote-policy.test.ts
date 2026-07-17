import { describe, it, expect } from "vitest";
import { castDecision } from "@/lib/vote-policy";

const now = new Date("2026-07-17T12:00:00Z");
const open = {
  status: "voting",
  votingStartsAt: new Date("2026-07-17T00:00:00Z"),
  votingEndsAt: new Date("2026-07-18T00:00:00Z"),
};

describe("castDecision", () => {
  it("投票中＋在名冊 → 可投", () => {
    expect(castDecision(open, true, now)).toEqual({ ok: true });
  });

  it("非投票階段一律拒絕（含已彌封）", () => {
    for (const status of ["draft", "registration", "campaigning", "closed", "sealed", "published"]) {
      expect(castDecision({ ...open, status }, true, now)).toMatchObject({
        ok: false,
        reason: "not-open",
      });
    }
  });

  it("時間窗外拒絕", () => {
    expect(castDecision(open, true, new Date("2026-07-16T23:59:59Z"))).toMatchObject({
      reason: "not-started",
    });
    expect(castDecision(open, true, new Date("2026-07-18T00:00:01Z"))).toMatchObject({
      reason: "ended",
    });
  });

  it("時間未設定時只看狀態", () => {
    expect(
      castDecision({ status: "voting", votingStartsAt: null, votingEndsAt: null }, true, now),
    ).toEqual({ ok: true });
  });

  it("不在名冊拒絕", () => {
    expect(castDecision(open, false, now)).toMatchObject({ reason: "not-in-roster" });
  });
});

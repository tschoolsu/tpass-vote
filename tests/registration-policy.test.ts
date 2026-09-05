import { describe, it, expect } from "vitest";
import { registrationDecision } from "@/lib/registration-policy";

const now = new Date("2026-07-17T12:00:00Z");
const open = {
  status: "registration",
  registrationStartsAt: new Date("2026-07-17T00:00:00Z"),
  registrationEndsAt: new Date("2026-07-18T00:00:00Z"),
};

describe("registrationDecision", () => {
  it("登記中＋在時間窗內 → 可登記", () => {
    expect(registrationDecision(open, now)).toEqual({ ok: true });
  });

  it("非登記階段一律拒絕", () => {
    for (const status of ["draft", "campaigning", "voting", "closed", "sealed", "published"]) {
      expect(registrationDecision({ ...open, status }, now)).toMatchObject({
        ok: false,
        reason: "not-open",
      });
    }
  });

  it("時間窗外拒絕", () => {
    expect(registrationDecision(open, new Date("2026-07-16T23:59:59Z"))).toMatchObject({
      reason: "not-started",
    });
    expect(registrationDecision(open, new Date("2026-07-18T00:00:01Z"))).toMatchObject({
      reason: "ended",
    });
  });

  it("時間未設定時只看狀態", () => {
    expect(
      registrationDecision(
        { status: "registration", registrationStartsAt: null, registrationEndsAt: null },
        now,
      ),
    ).toEqual({ ok: true });
  });
});

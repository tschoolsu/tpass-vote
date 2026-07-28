import { describe, it, expect } from "vitest";
import { recallThreshold, recallPassed, canInitiateRecall, recallEligibleFrom } from "@/lib/recall";

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

// D12-3 補：撞號票在 buildDisclosures 裡標成 kind="invalid" + reason="duplicate-code"，
// 但公開明細（結果頁／CSV／收據查詢）都要能把這個理由講給人看，不能跟「單純解不開的
// 爛票」顯示成同一句「無效票」——否則投票人查自己的收據看不出發生了什麼事。
import { describe, it, expect } from "vitest";
import { describeDisclosure } from "@/components/public/shared";

describe("describeDisclosure：撞號無效票要與一般無效票分開顯示", () => {
  it("kind=invalid 且 reason=duplicate-code 顯示「代碼重複，無效」", () => {
    expect(describeDisclosure({ kind: "invalid", reason: "duplicate-code" }, {})).toBe(
      "代碼重複，無效",
    );
  });

  it("kind=invalid 沒有 reason（一般無效票）仍顯示「無效票」", () => {
    expect(describeDisclosure({ kind: "invalid" }, {})).toBe("無效票");
  });
});

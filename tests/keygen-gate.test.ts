import { describe, it, expect } from "vitest";
import { DEFAULT_KEY_SHARES, canSubmitKeys, type ShareGateState } from "@/lib/keygen-gate";

describe("開票金鑰下載/確認閘門", () => {
  it("預設分持份數是 2 份", () => {
    expect(DEFAULT_KEY_SHARES).toBe(2);
  });

  it("2 份只下載其中 1 份，不能送出", () => {
    const states: ShareGateState[] = [
      { downloaded: true, confirmed: true },
      { downloaded: false, confirmed: false },
    ];
    expect(canSubmitKeys(states)).toBe(false);
  });

  it("2 份都下載但只勾 1 份確認，不能送出", () => {
    const states: ShareGateState[] = [
      { downloaded: true, confirmed: true },
      { downloaded: true, confirmed: false },
    ];
    expect(canSubmitKeys(states)).toBe(false);
  });

  it("2 份都下載且都確認，才能送出", () => {
    const states: ShareGateState[] = [
      { downloaded: true, confirmed: true },
      { downloaded: true, confirmed: true },
    ];
    expect(canSubmitKeys(states)).toBe(true);
  });

  it("沒有任何金鑰檔（空陣列）不能送出", () => {
    expect(canSubmitKeys([])).toBe(false);
  });

  it("1 份下載且確認即可送出", () => {
    expect(canSubmitKeys([{ downloaded: true, confirmed: true }])).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { buildDisclosures, verifyDisclosures, type DisclosureEntry } from "@/lib/disclosure";
import { tallyBallots, type TallyInput } from "@/lib/tally";
import type { BallotPlain } from "@/lib/ballot-crypto";

const E = "election-1";
const choose = (...ids: string[]): BallotPlain => ({
  v: 1,
  electionId: E,
  choice: { type: "choose", candidateIds: ids },
});
const approval = (approvals: Record<string, boolean>): BallotPlain => ({
  v: 1,
  electionId: E,
  choice: { type: "approval", approvals },
});
const blank: BallotPlain = { v: 1, electionId: E, choice: { type: "blank" } };

// 代碼實際上是密文雜湊，測試裡只要求「12 碼、彼此不同」即可。
const code = (n: number) => `${n}`.padStart(12, "0");

function tally(overrides: Partial<TallyInput>) {
  return tallyBallots({
    electionId: E,
    ballotMode: "choose",
    seats: 1,
    maxChoices: 1,
    candidateIds: ["a", "b", "c"],
    plaintexts: [],
    rosterCount: 10,
    ...overrides,
  });
}

describe("buildDisclosures", () => {
  it("逐票翻成代碼↔意思，並依代碼排序（與彌封順序無關）", () => {
    const plaintexts = [choose("a"), blank, null, choose("b")];
    const codes = [code(3), code(1), code(4), code(2)];
    const entries = buildDisclosures(codes, plaintexts, E, "choose", ["a", "b", "c"], 1);

    expect(entries.map((e) => e.code)).toEqual([code(1), code(2), code(3), code(4)]);
    expect(entries.find((e) => e.code === code(3))).toMatchObject({
      kind: "choose",
      candidateIds: ["a"],
    });
    expect(entries.find((e) => e.code === code(1))!.kind).toBe("blank");
    expect(entries.find((e) => e.code === code(4))!.kind).toBe("invalid");
  });

  it("分類與 tally 一致：超額圈選、跨場密文、非本場候選人都算無效票", () => {
    const foreign: BallotPlain = { v: 1, electionId: "other", choice: { type: "blank" } };
    const plaintexts = [choose("a", "b"), foreign, choose("zzz")];
    const codes = [code(1), code(2), code(3)];
    const entries = buildDisclosures(codes, plaintexts, E, "choose", ["a", "b", "c"], 1);
    expect(entries.every((e) => e.kind === "invalid")).toBe(true);

    const results = tally({ plaintexts });
    expect(results.invalidCount).toBe(3);
  });

  it("approval 模式記錄每位候選人的同意／不同意", () => {
    const entries = buildDisclosures(
      [code(1)],
      [approval({ a: true, b: false })],
      E,
      "approval",
      ["a", "b"],
      1,
    );
    expect(entries[0]).toMatchObject({ kind: "approval", approvals: { a: true, b: false } });
  });
});

describe("verifyDisclosures", () => {
  const plaintexts = [choose("a"), choose("a"), choose("b"), blank, null];
  const codes = [code(1), code(2), code(3), code(4), code(5)];
  const results = tally({ plaintexts });
  const entries = buildDisclosures(codes, plaintexts, E, "choose", ["a", "b", "c"], 1);

  it("開票端產出的明細與計票結果自洽", () => {
    expect(verifyDisclosures(entries, codes, results, 1)).toBeNull();
  });

  it("張數不符", () => {
    expect(verifyDisclosures(entries.slice(1), codes, results, 1)).toBe("count");
  });

  it("代碼不符", () => {
    const tampered = entries.map((e) =>
      e.code === code(1) ? { ...e, code: code(9) } : e,
    );
    expect(verifyDisclosures(tampered, codes, results, 1)).toBe("codes");
  });

  it("重複代碼", () => {
    const dup: DisclosureEntry[] = [...entries.slice(1), { ...entries[1] }];
    expect(verifyDisclosures(dup, codes, results, 1)).toBe("duplicate-code");
  });

  it("各類票張數對不上", () => {
    const tampered = entries.map((e) => (e.kind === "blank" ? { ...e, kind: "invalid" as const } : e));
    expect(verifyDisclosures(tampered, codes, results, 1)).toBe("class-count");
  });

  it("逐票加總的得票數對不上", () => {
    const tampered = entries.map((e) =>
      e.kind === "choose" && e.candidateIds?.[0] === "a" ? { ...e, candidateIds: ["b"] } : e,
    );
    expect(verifyDisclosures(tampered, codes, results, 1)).toBe("votes");
  });

  it("明細出現超過可圈選人數的選票", () => {
    const tampered = entries.map((e) =>
      e.kind === "choose" ? { ...e, candidateIds: ["a", "b"] } : e,
    );
    expect(verifyDisclosures(tampered, codes, results, 1)).toBe("max-choices");
  });
});

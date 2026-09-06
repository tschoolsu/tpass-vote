import { describe, it, expect } from "vitest";
import { buildDisclosures, verifyDisclosures, type DisclosureEntry } from "@/lib/disclosure";
import { tallyBallots, type TallyInput, type TallyResult } from "@/lib/tally";
import type { BallotPlain } from "@/lib/ballot-crypto";

const E = "election-1";
const choose = (...ids: string[]): BallotPlain => ({
  v: 2,
  electionId: E,
  code: "000000000000",
  choice: { type: "choose", candidateIds: ids },
});
const approval = (approvals: Record<string, boolean>): BallotPlain => ({
  v: 2,
  electionId: E,
  code: "000000000000",
  choice: { type: "approval", approvals },
});
const blank: BallotPlain = { v: 2, electionId: E, code: "000000000000", choice: { type: "blank" } };

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
    const foreign: BallotPlain = { v: 2, electionId: "other", code: "000000000000", choice: { type: "blank" } };
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
    expect(verifyDisclosures(entries, codes.length, results, 1)).toBeNull();
  });

  it("張數不符", () => {
    expect(verifyDisclosures(entries.slice(1), codes.length, results, 1)).toBe("count");
  });

  // 代碼改由投票人瀏覽器產生、封在密文內部之後，伺服器沒有私鑰就算不出代碼，
  // 「代碼集合與票匭相符」這項對帳已經不存在。這條測試把失去的東西寫清楚，
  // 免得日後有人以為伺服器還擋得住。防線改為兩位選委各自獨立開票比對。
  it("代碼被換掉伺服器察覺不到（放棄代碼對帳的刻意取捨）", () => {
    const tampered = entries.map((e) => (e.code === code(1) ? { ...e, code: code(9) } : e));
    expect(verifyDisclosures(tampered, codes.length, results, 1)).toBeNull();
  });

  it("明細出現不在本場核准名單內的候選人", () => {
    const tampered = entries.map((e) =>
      e.kind === "choose" ? { ...e, candidateIds: ["not-a-candidate"] } : e,
    );
    expect(verifyDisclosures(tampered, codes.length, results, 1)).toBe("codes");
  });

  it("重複代碼", () => {
    const dup: DisclosureEntry[] = [...entries.slice(1), { ...entries[1] }];
    expect(verifyDisclosures(dup, codes.length, results, 1)).toBe("duplicate-code");
  });

  it("各類票張數對不上", () => {
    const tampered = entries.map((e) => (e.kind === "blank" ? { ...e, kind: "invalid" as const } : e));
    expect(verifyDisclosures(tampered, codes.length, results, 1)).toBe("class-count");
  });

  it("逐票加總的得票數對不上", () => {
    const tampered = entries.map((e) =>
      e.kind === "choose" && e.candidateIds?.[0] === "a" ? { ...e, candidateIds: ["b"] } : e,
    );
    expect(verifyDisclosures(tampered, codes.length, results, 1)).toBe("votes");
  });

  it("明細出現超過可圈選人數的選票", () => {
    const tampered = entries.map((e) =>
      e.kind === "choose" ? { ...e, candidateIds: ["a", "b"] } : e,
    );
    expect(verifyDisclosures(tampered, codes.length, results, 1)).toBe("max-choices");
  });
});

// D4-3：disclosure 端的 well-formed 判定曾比 tally.ts 寬鬆，讓「有效票數對得上、
// 但沒有加給任何候選人（或票數被灌水）」的自洽假結果騙過 verifyDisclosures。
// 這裡直接構造 results + entries，不經過 tallyBallots，隔離出 well-formed 這一項判定本身。
describe("verifyDisclosures 的 well-formed 判定必須與 tally.ts 一致（D4-3）", () => {
  const fakeResults = (votesA: number): TallyResult => ({
    mode: "choose",
    totalBallots: 1,
    validCount: 1,
    blankCount: 0,
    invalidCount: 0,
    rosterCount: 10,
    turnoutPct: 10,
    candidates: [
      { candidateId: "a", votes: votesA, disagree: 0, elected: false, tied: false },
      { candidateId: "b", votes: 0, disagree: 0, elected: false, tied: false },
      { candidateId: "c", votes: 0, disagree: 0, elected: false, tied: false },
    ],
    hasTie: false,
  });

  it("空 candidateIds 不應被當有效票收下", () => {
    const entries: DisclosureEntry[] = [{ code: code(1), kind: "choose", candidateIds: [] }];
    expect(verifyDisclosures(entries, 1, fakeResults(0), 1)).not.toBeNull();
  });

  it("單張票內重複 candidateId 不應被當有效票收下", () => {
    const entries: DisclosureEntry[] = [{ code: code(1), kind: "choose", candidateIds: ["a", "a"] }];
    // maxChoices=2：刻意不觸發既有的「超額」檢查，隔離出重複圈選這一項
    expect(verifyDisclosures(entries, 1, fakeResults(2), 2)).not.toBeNull();
  });

  it("空 approvals 不應被當有效票收下", () => {
    const entries: DisclosureEntry[] = [{ code: code(1), kind: "approval", approvals: {} }];
    expect(verifyDisclosures(entries, 1, fakeResults(0), 1)).not.toBeNull();
  });
});

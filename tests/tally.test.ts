import { describe, it, expect } from "vitest";
import { tallyBallots, decideElected, type TallyInput } from "@/lib/tally";
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

function base(overrides: Partial<TallyInput>): TallyInput {
  return {
    electionId: E,
    ballotMode: "choose",
    seats: 1,
    maxChoices: 1,
    candidateIds: ["a", "b", "c"],
    plaintexts: [],
    rosterCount: 10,
    ...overrides,
  };
}

describe("choose（超額，相對多數）", () => {
  it("最高票當選，廢票與無效票分開計，投票率含所有入匭票", () => {
    const r = tallyBallots(
      base({
        plaintexts: [choose("a"), choose("a"), choose("b"), blank, null],
      }),
    );
    expect(r.candidates.find((c) => c.candidateId === "a")).toMatchObject({
      votes: 2,
      elected: true,
      tied: false,
    });
    expect(r.candidates.find((c) => c.candidateId === "b")).toMatchObject({
      votes: 1,
      elected: false,
    });
    expect(r.validCount).toBe(3);
    expect(r.blankCount).toBe(1);
    expect(r.invalidCount).toBe(1);
    expect(r.totalBallots).toBe(5);
    expect(r.turnoutPct).toBe(50);
    expect(r.hasTie).toBe(false);
  });

  it("席次邊界同票：同票者標 tied 不當選，高於邊界者照常當選", () => {
    const r = tallyBallots(
      base({
        seats: 2,
        plaintexts: [
          choose("a"), choose("a"), choose("a"),
          choose("b"), choose("c"),
        ],
      }),
    );
    expect(r.hasTie).toBe(true);
    expect(r.candidates.find((c) => c.candidateId === "a")).toMatchObject({
      elected: true,
      tied: false,
    });
    expect(r.candidates.find((c) => c.candidateId === "b")).toMatchObject({
      elected: false,
      tied: true,
    });
    expect(r.candidates.find((c) => c.candidateId === "c")).toMatchObject({
      elected: false,
      tied: true,
    });
  });

  it("圈選超過 maxChoices、重複圈選、圈不存在的人 → 無效票", () => {
    const r = tallyBallots(
      base({
        plaintexts: [
          choose("a", "b"), // 超過 maxChoices=1
          choose("a", "a"), // 重複（也超額，雙重不合規）
          choose("ghost"), // 不存在
          { v: 2, electionId: "wrong", code: "000000000000", choice: { type: "choose", candidateIds: ["a"] } },
        ],
      }),
    );
    expect(r.invalidCount).toBe(4);
    expect(r.validCount).toBe(0);
  });

  it("maxChoices=2 時可圈兩人", () => {
    const r = tallyBallots(
      base({ seats: 2, maxChoices: 2, plaintexts: [choose("a", "b")] }),
    );
    expect(r.validCount).toBe(1);
    expect(r.candidates.find((c) => c.candidateId === "a")!.votes).toBe(1);
    expect(r.candidates.find((c) => c.candidateId === "b")!.votes).toBe(1);
  });

  // §13：學生代表為複數選區單記不可讓渡——每人一票（maxChoices=1）、複數席次（seats>1），
  // 得票前 N 名當選，票不移轉。
  it("SNTV：seats=3、maxChoices=1，得票前三名當選", () => {
    const r = tallyBallots(
      base({
        seats: 3,
        maxChoices: 1,
        candidateIds: ["a", "b", "c", "d", "e", "f", "g"],
        plaintexts: [
          choose("a"), choose("a"), choose("a"), choose("a"),
          choose("b"), choose("b"), choose("b"),
          choose("c"), choose("c"),
          choose("d"),
          choose("e"),
        ],
      }),
    );
    const elected = r.candidates.filter((c) => c.elected).map((c) => c.candidateId).sort();
    expect(elected).toEqual(["a", "b", "c"]);
    expect(r.hasTie).toBe(false);
    expect(r.validCount).toBe(11);
    // 單記：圈兩人即超過上限，算無效票
    const over = tallyBallots(
      base({ seats: 3, maxChoices: 1, plaintexts: [choose("a", "b")] }),
    );
    expect(over.invalidCount).toBe(1);
    expect(over.validCount).toBe(0);
  });
});

describe("approval（同額，同意/不同意）", () => {
  it("同意 > 不同意才當選", () => {
    const r = tallyBallots(
      base({
        ballotMode: "approval",
        candidateIds: ["a", "b"],
        plaintexts: [
          approval({ a: true, b: false }),
          approval({ a: true, b: true }),
          approval({ a: false, b: false }),
        ],
      }),
    );
    expect(r.candidates.find((c) => c.candidateId === "a")).toMatchObject({
      votes: 2,
      disagree: 1,
      elected: true,
    });
    expect(r.candidates.find((c) => c.candidateId === "b")).toMatchObject({
      votes: 1,
      disagree: 2,
      elected: false,
    });
  });

  it("同意＝不同意 → 不當選（法條要求「多於」）", () => {
    const r = tallyBallots(
      base({
        ballotMode: "approval",
        candidateIds: ["a"],
        plaintexts: [approval({ a: true }), approval({ a: false })],
      }),
    );
    expect(r.candidates[0].elected).toBe(false);
  });

  it("空 approvals、圈到非候選人 → 無效票", () => {
    const r = tallyBallots(
      base({
        ballotMode: "approval",
        candidateIds: ["a"],
        plaintexts: [approval({}), approval({ ghost: true })],
      }),
    );
    expect(r.invalidCount).toBe(2);
  });

  it("choose 票混進 approval 場（或反之）→ 無效票", () => {
    const r = tallyBallots(
      base({
        ballotMode: "approval",
        candidateIds: ["a"],
        plaintexts: [choose("a")],
      }),
    );
    expect(r.invalidCount).toBe(1);
  });
});

describe("decideElected（純函式，供 tallyBallots 與 submitResults 共用）", () => {
  it("choose：席次邊界同票 → 邊界票數者全標 tied、不當選", () => {
    const r = decideElected("choose", 2, [
      { candidateId: "a", votes: 3, disagree: 0 },
      { candidateId: "b", votes: 2, disagree: 0 },
      { candidateId: "c", votes: 2, disagree: 0 },
    ]);
    expect(r.hasTie).toBe(true);
    expect(r.candidates.find((c) => c.candidateId === "a")).toMatchObject({ elected: true, tied: false });
    expect(r.candidates.find((c) => c.candidateId === "b")).toMatchObject({ elected: false, tied: true });
    expect(r.candidates.find((c) => c.candidateId === "c")).toMatchObject({ elected: false, tied: true });
  });

  it("choose：候選人數不足席次時全數當選、無同票", () => {
    const r = decideElected("choose", 3, [
      { candidateId: "a", votes: 5, disagree: 0 },
      { candidateId: "b", votes: 1, disagree: 0 },
    ]);
    expect(r.hasTie).toBe(false);
    expect(r.candidates.every((c) => c.elected && !c.tied)).toBe(true);
  });

  it("approval：同意等於不同意 → 不當選（跟 tallyBallots 的規則一致）", () => {
    const r = decideElected("approval", 1, [{ candidateId: "a", votes: 2, disagree: 2 }]);
    expect(r.candidates[0]).toMatchObject({ elected: false, tied: false });
    expect(r.hasTie).toBe(false);
  });
});

describe("邊界", () => {
  it("名冊為 0 時投票率為 0，不除以零", () => {
    const r = tallyBallots(base({ rosterCount: 0, plaintexts: [] }));
    expect(r.turnoutPct).toBe(0);
  });

  it("全部同票且超過席次：全標 tied、無人當選", () => {
    const r = tallyBallots(
      base({ seats: 1, plaintexts: [choose("a"), choose("b"), choose("c")] }),
    );
    expect(r.hasTie).toBe(true);
    expect(r.candidates.every((c) => c.tied && !c.elected)).toBe(true);
  });
});

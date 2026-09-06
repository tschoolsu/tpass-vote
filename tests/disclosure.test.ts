import { describe, it, expect } from "vitest";
import { buildDisclosures, verifyDisclosures, type DisclosureEntry } from "@/lib/disclosure";
import { tallyBallots, type TallyInput, type TallyResult } from "@/lib/tally";
import type { BallotPlain } from "@/lib/ballot-crypto";

const E = "election-1";
// 每張票預設要有各自不同的代碼——tallyBallots 現在會把同代碼的票視為串通、標為
// 無效（D12-3），固定同一個假代碼會讓 tally() 那條路徑的票互相「撞號」。
// buildDisclosures 用的是外部傳入的 codes[] 參數、不看這裡的 code，不受影響；
// 想刻意測撞號時，各測試自己組 BallotPlain／codes 指定相同的值。
let codeSeq = 0;
const uniqueCode = () => (++codeSeq).toString(16).padStart(12, "0");
const choose = (...ids: string[]): BallotPlain => ({
  v: 2,
  electionId: E,
  code: uniqueCode(),
  choice: { type: "choose", candidateIds: ids },
});
const approval = (approvals: Record<string, boolean>): BallotPlain => ({
  v: 2,
  electionId: E,
  code: uniqueCode(),
  choice: { type: "approval", approvals },
});
const blankBallot = (): BallotPlain => ({ v: 2, electionId: E, code: uniqueCode(), choice: { type: "blank" } });

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
    const plaintexts = [choose("a"), blankBallot(), null, choose("b")];
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
  const plaintexts = [choose("a"), choose("a"), choose("b"), blankBallot(), null];
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

  // D12-3：重複代碼本身不再是拒收理由（見下面獨立的 describe），但重複代碼裡只要
  // 有一張還宣稱自己有效，就代表明細沒有依規則把撞號的票改標無效——這種才要擋下來。
  it("重複代碼但不是全部標為 invalid：拒收", () => {
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

// D12-3：代碼由投票人瀏覽器產生、封在密文內部，伺服器收票時看不到，兩位串通的
// 選舉人可以各自送出一張「代碼相同」的密文。修法前 buildDisclosures 會把兩張各自
// 判成有效票，verifyDisclosures 一遇到重複代碼就讓整批提交被拒收，全場開不了票。
// 修法後：撞號的票在明細端全部改標 invalid，計票端也不算給任何候選人，兩邊自洽，
// verifyDisclosures 因此通過。
describe("重複代碼（D12-3）：串通票在明細與計票兩端一致地算無效票", () => {
  it("明細兩張皆標為 invalid、與計票結果自洽、驗證通過", () => {
    const DUP = "aaaaaaaaaaaa";
    const OTHER = "bbbbbbbbbbbb";
    const dupA: BallotPlain = { v: 2, electionId: E, code: DUP, choice: { type: "choose", candidateIds: ["a"] } };
    const dupB: BallotPlain = { v: 2, electionId: E, code: DUP, choice: { type: "choose", candidateIds: ["b"] } };
    const other: BallotPlain = { v: 2, electionId: E, code: OTHER, choice: { type: "choose", candidateIds: ["c"] } };
    const plaintexts = [dupA, dupB, other];
    // 比照 tally-client.ts 的做法：外部 codes[] 就是明文自帶的 code。
    const codes = plaintexts.map((p) => p.code);

    const results = tally({ plaintexts });
    expect(results.invalidCount).toBe(2);
    expect(results.validCount).toBe(1);
    expect(results.candidates.find((c) => c.candidateId === "a")!.votes).toBe(0);
    expect(results.candidates.find((c) => c.candidateId === "b")!.votes).toBe(0);
    expect(results.candidates.find((c) => c.candidateId === "c")!.votes).toBe(1);

    const entries = buildDisclosures(codes, plaintexts, E, "choose", ["a", "b", "c"], 1);
    const dupEntries = entries.filter((e) => e.code === DUP);
    expect(dupEntries).toHaveLength(2);
    expect(dupEntries.every((e) => e.kind === "invalid")).toBe(true);

    expect(verifyDisclosures(entries, codes.length, results, 1)).toBeNull();
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

  // 審查發現的漏洞：verifyDisclosures 只依明細自稱的 kind 分支、從不比對
  // results.mode，所以把 choose 場的明細全換成 kind="approval" 就能繞過上面
  // 三項 well-formed 檢查（approval 判定較寬鬆、且不受 maxChoices 限制），
  // 構造出「有效票數對得上、卻沒有加給任何候選人」的自洽假結果。
  it("choose 場塞 kind=approval 的明細不應被放行（繞過 well-formed 判定）", () => {
    const entries: DisclosureEntry[] = Array.from({ length: 10 }, (_, i) => ({
      code: code(i + 1),
      kind: "approval",
      approvals: { a: false },
    }));
    const forged: TallyResult = {
      mode: "choose",
      totalBallots: 10,
      validCount: 10,
      blankCount: 0,
      invalidCount: 0,
      rosterCount: 100,
      turnoutPct: 10,
      hasTie: false,
      candidates: [
        { candidateId: "a", votes: 0, disagree: 10, elected: true, tied: false },
        { candidateId: "b", votes: 0, disagree: 0, elected: false, tied: false },
        { candidateId: "c", votes: 0, disagree: 0, elected: false, tied: false },
      ],
    };
    expect(verifyDisclosures(entries, 10, forged, 1)).not.toBeNull();
  });

  // 反向：approval 場塞 kind="choose" 的明細，同樣要被擋下來。
  it("approval 場塞 kind=choose 的明細不應被放行", () => {
    const entries: DisclosureEntry[] = [{ code: code(1), kind: "choose", candidateIds: ["a"] }];
    const forged: TallyResult = {
      mode: "approval",
      totalBallots: 1,
      validCount: 1,
      blankCount: 0,
      invalidCount: 0,
      rosterCount: 10,
      turnoutPct: 10,
      hasTie: false,
      candidates: [
        { candidateId: "a", votes: 1, disagree: 0, elected: true, tied: false },
        { candidateId: "b", votes: 0, disagree: 0, elected: false, tied: false },
      ],
    };
    expect(verifyDisclosures(entries, 1, forged, 1)).not.toBeNull();
  });
});

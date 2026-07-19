import { describe, it, expect } from "vitest";
import { resultAnnouncementDraft } from "@/lib/result-announcement";
import type { TallyResult } from "@/lib/tally";

const election = { title: "2026 學生會長選舉", kind: "leader", seats: 1 };

const candidates = [
  { id: "a", number: 1, members: [{ name: "王小明" }, { name: "陳小華" }] },
  { id: "b", number: 2, members: [{ name: "林小美" }, { name: "張小強" }] },
];

function baseResult(overrides: Partial<TallyResult> = {}): TallyResult {
  return {
    mode: "choose",
    totalBallots: 10,
    validCount: 9,
    blankCount: 1,
    invalidCount: 0,
    rosterCount: 20,
    turnoutPct: 50,
    candidates: [
      { candidateId: "a", votes: 6, disagree: 0, elected: true, tied: false },
      { candidateId: "b", votes: 3, disagree: 0, elected: false, tied: false },
    ],
    hasTie: false,
    ...overrides,
  };
}

describe("resultAnnouncementDraft", () => {
  it("產出含選舉名稱、投票率、當選標示的 markdown 草稿", () => {
    const { title, body } = resultAnnouncementDraft(election, baseResult(), candidates);
    expect(title).toContain("2026 學生會長選舉");
    expect(body).toContain("投票率 50%");
    expect(body).toContain("王小明・陳小華（副手）");
    expect(body).toContain("**（當選）**");
    expect(body).not.toContain("undefined");
  });

  it("hasTie 時附上同票說明，且同票候選人標示為待決議", () => {
    const results = baseResult({
      hasTie: true,
      candidates: [
        { candidateId: "a", votes: 5, disagree: 0, elected: false, tied: true },
        { candidateId: "b", votes: 5, disagree: 0, elected: false, tied: true },
      ],
    });
    const { body } = resultAnnouncementDraft(election, results, candidates);
    expect(body).toContain("同票說明");
    expect(body).toContain("待選委會決議");
  });

  it("approval 模式顯示同意/不同意票數", () => {
    const results = baseResult({
      mode: "approval",
      candidates: [{ candidateId: "a", votes: 7, disagree: 2, elected: true, tied: false }],
    });
    const { body } = resultAnnouncementDraft(election, results, candidates);
    expect(body).toContain("同意 7 票、不同意 2 票");
  });

  it("找不到候選人資料時用 candidateId 當備援標籤，不會炸", () => {
    const results = baseResult({
      candidates: [{ candidateId: "ghost", votes: 1, disagree: 0, elected: true, tied: false }],
    });
    const { body } = resultAnnouncementDraft(election, results, []);
    expect(body).toContain("ghost");
  });
});

describe("resultAnnouncementDraft（罷免，kind=recall）", () => {
  const recallElection = { title: "2026 學生會長選舉罷免案", kind: "recall", seats: 1 };
  const recallCandidates = [
    { id: "target", number: 1, members: [{ name: "王小明" }, { name: "陳小華" }] },
  ];

  function recallResult(votes: number, disagree: number): TallyResult {
    return {
      mode: "approval",
      totalBallots: votes + disagree + 1,
      validCount: votes + disagree,
      blankCount: 1,
      invalidCount: 0,
      rosterCount: 100,
      turnoutPct: 50,
      candidates: [
        { candidateId: "target", votes, disagree, elected: votes > disagree, tied: false },
      ],
      hasTie: false,
    };
  }

  it("通過：同意罷免多於不同意罷免，標示通過且敘明解除職務／45 日內補選", () => {
    const { title, body } = resultAnnouncementDraft(
      recallElection,
      recallResult(60, 40),
      recallCandidates,
    );
    expect(title).toContain("2026 學生會長選舉罷免案");
    expect(body).toContain("同意罷免 60 票、不同意罷免 40 票");
    expect(body).toContain("（通過）");
    expect(body).toContain("解除職務");
    expect(body).toContain("45 日內");
    expect(body).not.toContain("當選");
    expect(body).not.toContain("undefined");
  });

  it("否決：同意罷免不多於不同意罷免，標示否決且敘明同一事由不得再提", () => {
    const { body } = resultAnnouncementDraft(recallElection, recallResult(40, 60), recallCandidates);
    expect(body).toContain("（否決）");
    expect(body).toContain("同一事由");
    expect(body).toContain("不得再為罷免案之提出");
    expect(body).not.toContain("解除職務");
  });

  it("同票（同意等於不同意）依 recallPassed 規則視為否決", () => {
    const { body } = resultAnnouncementDraft(recallElection, recallResult(50, 50), recallCandidates);
    expect(body).toContain("（否決）");
  });

  it("廢票數如實反映在投票率說明段落中", () => {
    const results = recallResult(30, 20);
    results.blankCount = 7;
    results.totalBallots = 30 + 20 + 7;
    const { body } = resultAnnouncementDraft(recallElection, results, recallCandidates);
    expect(body).toContain("廢票 7 張");
  });

  it("找不到候選人資料時用 candidateId 當備援標籤，不會炸", () => {
    const { body } = resultAnnouncementDraft(recallElection, recallResult(10, 5), []);
    expect(body).toContain("target");
    expect(body).not.toContain("undefined");
  });
});

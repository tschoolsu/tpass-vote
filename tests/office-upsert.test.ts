import { describe, it, expect } from "vitest";
import {
  officeTitleForWinner,
  buildDiff,
  upsertOfficesForElection,
  type UpsertElectionInfo,
  type UpsertCandidateInfo,
} from "@/lib/office-upsert";
import type { TallyResult } from "@/lib/tally";

describe("officeTitleForWinner", () => {
  it("第一組沿用選舉名稱", () => {
    expect(officeTitleForWinner("學生會長選舉", 0, 1)).toBe("學生會長選舉");
  });
  it("第二組起加號次尾碼避免重名", () => {
    expect(officeTitleForWinner("其他委員選舉", 1, 2)).toBe("其他委員選舉（第2號）");
    expect(officeTitleForWinner("其他委員選舉", 2, null)).toBe("其他委員選舉（第3號）"); // number 缺 → 用 index+1
  });
});

describe("buildDiff", () => {
  it("只保留有變動的欄位", () => {
    const diff = buildDiff({
      a: [1, 1],
      b: ["x", "y"],
      c: [null, null],
    });
    expect(diff).toEqual({ b: { from: "x", to: "y" } });
  });
  it("以 JSON 深比較物件/陣列", () => {
    const diff = buildDiff({
      members: [[{ name: "甲" }], [{ name: "甲" }]],
      changed: [[{ name: "甲" }], [{ name: "乙" }]],
    });
    expect(Object.keys(diff)).toEqual(["changed"]);
  });
});

// 極簡 fake TransactionClient：只實作被呼叫的方法，記錄狀態供斷言。
function makeFakeTx(offices: Record<string, Record<string, unknown>> = {}) {
  const logs: { officeId: string; action: string; summary: string }[] = [];
  let seq = 1;
  const tx = {
    office: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `office-${seq++}`;
        offices[id] = { id, ...data };
        return offices[id];
      },
      findUnique: async ({ where }: { where: { id: string } }) => offices[where.id] ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        offices[where.id] = { ...offices[where.id], ...data };
        return offices[where.id];
      },
    },
    officeEditLog: {
      create: async ({ data }: { data: { officeId: string; action: string; summary: string } }) => {
        logs.push({ officeId: data.officeId, action: data.action, summary: data.summary });
        return data;
      },
    },
    election: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        offices[`election:${where.id}`] = { ...(offices[`election:${where.id}`] ?? {}), ...data };
        return data;
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { tx: tx as any, offices, logs };
}

function tally(overrides: Partial<TallyResult> & { candidates: TallyResult["candidates"] }): TallyResult {
  return {
    mode: "choose",
    totalBallots: 0,
    validCount: 100,
    blankCount: 0,
    invalidCount: 0,
    rosterCount: 0,
    turnoutPct: 0,
    hasTie: false,
    ...overrides,
  };
}

const cand = (id: string, elected: boolean, votes = 10, disagree = 0): TallyResult["candidates"][number] => ({
  candidateId: id,
  votes,
  disagree,
  elected,
  tied: false,
});

describe("upsertOfficesForElection — genesis 一般選舉", () => {
  it("單一當選組 → 建一筆職務並回填 election.officeId", async () => {
    const { tx, offices, logs } = makeFakeTx();
    const election: UpsertElectionInfo = { id: "e1", kind: "leader", title: "會長選舉", officeId: null, recallTargetOfficeId: null };
    const candidates: UpsertCandidateInfo[] = [{ id: "c1", number: 1, members: [{ name: "甲" }, { name: "乙" }] }];
    await upsertOfficesForElection(tx, election, tally({ candidates: [cand("c1", true)] }), candidates);

    const created = Object.values(offices).find((o) => o.title === "會長選舉")!;
    expect(created).toBeTruthy();
    expect(created.currentMembers).toEqual([{ name: "甲" }, { name: "乙" }]);
    expect(created.termValidCount).toBe(100);
    expect(created.sourceElectionId).toBe("e1");
    expect(offices["election:e1"]).toEqual({ officeId: created.id }); // 回填
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("create");
  });

  it("多當選組 → 建多筆、不回填 election.officeId", async () => {
    const { tx, offices } = makeFakeTx();
    const election: UpsertElectionInfo = { id: "e2", kind: "other", title: "委員選舉", officeId: null, recallTargetOfficeId: null };
    const candidates: UpsertCandidateInfo[] = [
      { id: "c1", number: 1, members: [{ name: "甲" }] },
      { id: "c2", number: 2, members: [{ name: "乙" }] },
    ];
    await upsertOfficesForElection(tx, election, tally({ candidates: [cand("c1", true), cand("c2", true)] }), candidates);
    const titles = Object.values(offices).map((o) => o.title).filter(Boolean);
    expect(titles).toContain("委員選舉");
    expect(titles).toContain("委員選舉（第2號）");
    expect(offices["election:e2"]).toBeUndefined(); // 多筆不回填
  });
});

describe("upsertOfficesForElection — 已關聯職務更新", () => {
  it("election.officeId 有值 → 更新該職務、換人", async () => {
    const { tx, offices, logs } = makeFakeTx({
      "o-hall": { id: "o-hall", title: "學生會長", currentMembers: [{ name: "舊人" }], isVacant: false, startedAt: null, sourceElectionId: "e0", termValidCount: 50 },
    });
    const election: UpsertElectionInfo = { id: "e3", kind: "leader", title: "第二屆會長選舉", officeId: "o-hall", recallTargetOfficeId: null };
    const candidates: UpsertCandidateInfo[] = [{ id: "c1", number: 1, members: [{ name: "新人" }] }];
    await upsertOfficesForElection(tx, election, tally({ candidates: [cand("c1", true)] }), candidates);
    expect(offices["o-hall"].currentMembers).toEqual([{ name: "新人" }]);
    expect(offices["o-hall"].sourceElectionId).toBe("e3");
    expect(logs.at(-1)!.action).toBe("update");
  });
});

describe("upsertOfficesForElection — 罷免案", () => {
  it("通過（同意>不同意）→ 目標職務轉從缺", async () => {
    const { tx, offices, logs } = makeFakeTx({
      "o-x": { id: "o-x", title: "會長", currentMembers: [{ name: "甲" }], isVacant: false, startedAt: new Date(), sourceElectionId: "e0", termValidCount: 100 },
    });
    const election: UpsertElectionInfo = { id: "r1", kind: "recall", title: "會長罷免案", officeId: null, recallTargetOfficeId: "o-x" };
    await upsertOfficesForElection(tx, election, tally({ mode: "approval", candidates: [cand("cc", false, 60, 40)] }), []);
    expect(offices["o-x"].isVacant).toBe(true);
    expect(offices["o-x"].currentMembers).toEqual([]);
    expect(offices["o-x"].startedAt).toBeNull();
    expect(logs.at(-1)!.summary).toContain("從缺");
  });

  it("否決（同意≤不同意）→ 完全不動職務", async () => {
    const started = new Date();
    const { tx, offices, logs } = makeFakeTx({
      "o-y": { id: "o-y", title: "會長", currentMembers: [{ name: "甲" }], isVacant: false, startedAt: started, sourceElectionId: "e0", termValidCount: 100 },
    });
    const election: UpsertElectionInfo = { id: "r2", kind: "recall", title: "會長罷免案", officeId: null, recallTargetOfficeId: "o-y" };
    await upsertOfficesForElection(tx, election, tally({ mode: "approval", candidates: [cand("cc", false, 40, 60)] }), []);
    expect(offices["o-y"].isVacant).toBe(false);
    expect(offices["o-y"].startedAt).toBe(started); // 就職時鐘不重置
    expect(logs).toHaveLength(0);
  });
});

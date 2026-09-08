import { describe, it, expect } from "vitest";
import {
  castDecision,
  CAST_REJECTION_MESSAGES,
  type CastRejection,
} from "@/lib/vote-policy";

const now = new Date("2026-07-17T12:00:00Z");
const open = {
  status: "voting",
  votingStartsAt: new Date("2026-07-17T00:00:00Z"),
  votingEndsAt: new Date("2026-07-18T00:00:00Z"),
};

describe("castDecision", () => {
  it("投票中＋在名冊 → 可投", () => {
    expect(castDecision(open, true, now)).toEqual({ ok: true });
  });

  it("非投票階段一律拒絕（含已彌封）", () => {
    for (const status of ["draft", "registration", "campaigning", "closed", "sealed", "published"]) {
      expect(castDecision({ ...open, status }, true, now)).toMatchObject({
        ok: false,
        reason: "not-open",
      });
    }
  });

  it("時間窗外拒絕", () => {
    expect(castDecision(open, true, new Date("2026-07-16T23:59:59Z"))).toMatchObject({
      reason: "not-started",
    });
    expect(castDecision(open, true, new Date("2026-07-18T00:00:01Z"))).toMatchObject({
      reason: "ended",
    });
  });

  it("時間未設定時只看狀態", () => {
    expect(
      castDecision({ status: "voting", votingStartsAt: null, votingEndsAt: null }, true, now),
    ).toEqual({ ok: true });
  });

  it("不在名冊拒絕", () => {
    expect(castDecision(open, false, now)).toMatchObject({ reason: "not-in-roster" });
  });

  // castDecision 是純函式，看不到 Voter.hasVoted，所以「已經投過」永遠不會從這裡回來——
  // 那件事只有在 castBallot 的鎖內讀得到，由它直接丟 CastRejected("already-voted")。
  // 這裡把它釘住：哪天有人想「順手」把 hasVoted 塞進這個純函式，這條會提醒他判定要在鎖內做。
  it("castDecision 不負責判定已投票", () => {
    const reasons = [
      castDecision({ ...open, status: "closed" }, true, now),
      castDecision(open, false, now),
      castDecision(open, true, new Date("2026-07-18T00:00:01Z")),
      castDecision(open, true, now),
    ];
    for (const r of reasons) {
      expect(r.ok === true || r.reason !== "already-voted").toBe(true);
    }
  });
});

describe("CAST_REJECTION_MESSAGES", () => {
  const ALL: CastRejection[] = [
    "not-open",
    "not-started",
    "ended",
    "not-in-roster",
    "already-voted",
  ];

  it("每個拒絕理由都有非空的中文文案", () => {
    for (const reason of ALL) {
      expect(CAST_REJECTION_MESSAGES[reason], reason).toBeTruthy();
      expect(CAST_REJECTION_MESSAGES[reason].length, reason).toBeGreaterThan(0);
    }
  });

  it("訊息表沒有多餘或漏掉的 key", () => {
    expect(Object.keys(CAST_REJECTION_MESSAGES).sort()).toEqual([...ALL].sort());
  });

  it("已投票的文案要講明不能更改，不能讓人以為重試就好", () => {
    expect(CAST_REJECTION_MESSAGES["already-voted"]).toMatch(/一次/);
    expect(CAST_REJECTION_MESSAGES["already-voted"]).toMatch(/無法更改|不能更改|不可更改/);
  });
});

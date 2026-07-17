// 投票資格判定（純函式，無 IO），供 castBallot server action 與單元測試共用。

export interface CastElectionState {
  status: string;
  votingStartsAt: Date | null;
  votingEndsAt: Date | null;
}

export type CastRejection = "not-open" | "not-started" | "ended" | "not-in-roster";

export function castDecision(
  election: CastElectionState,
  voterInRoster: boolean,
  now: Date,
): { ok: true } | { ok: false; reason: CastRejection } {
  if (election.status !== "voting") return { ok: false, reason: "not-open" };
  if (election.votingStartsAt && now < election.votingStartsAt) {
    return { ok: false, reason: "not-started" };
  }
  if (election.votingEndsAt && now > election.votingEndsAt) {
    return { ok: false, reason: "ended" };
  }
  if (!voterInRoster) return { ok: false, reason: "not-in-roster" };
  return { ok: true };
}

export const CAST_REJECTION_MESSAGES: Record<CastRejection, string> = {
  "not-open": "本場選舉目前不在投票階段",
  "not-started": "投票尚未開始",
  ended: "投票已截止",
  "not-in-roster": "你不在本場選舉的選舉人名冊中，如有疑義請聯絡選委會",
};

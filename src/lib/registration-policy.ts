// 候選人登記資格判定（純函式，無 IO），供 registerCandidate server action 與登記頁共用。
//
// 另立新檔而不是加進 vote-policy.ts：這裡要判斷的是 registrationStartsAt/EndsAt，
// 跟 vote-policy.ts 的 castDecision（判斷 votingStartsAt/EndsAt）是同一種「狀態機 vs
// 時程」問題（同一類根因見 A2 的修復），但 vote-policy.ts 當時有另一條線在動
// castDecision 相關邏輯，為避免同檔案的併發修改風險，比照它的判斷邏輯另開一個檔案。
export interface RegistrationElectionState {
  status: string;
  registrationStartsAt: Date | null;
  registrationEndsAt: Date | null;
}

export type RegistrationRejection = "not-open" | "not-started" | "ended";

export function registrationDecision(
  election: RegistrationElectionState,
  now: Date,
): { ok: true } | { ok: false; reason: RegistrationRejection } {
  if (election.status !== "registration") return { ok: false, reason: "not-open" };
  if (election.registrationStartsAt && now < election.registrationStartsAt) {
    return { ok: false, reason: "not-started" };
  }
  if (election.registrationEndsAt && now > election.registrationEndsAt) {
    return { ok: false, reason: "ended" };
  }
  return { ok: true };
}

export const REGISTRATION_REJECTION_MESSAGES: Record<RegistrationRejection, string> = {
  "not-open": "目前非候選人登記期間",
  "not-started": "候選人登記尚未開始",
  ended: "候選人登記已截止",
};

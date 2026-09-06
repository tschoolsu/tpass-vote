// 計票規則（純函式，無 IO）。在「選委瀏覽器」的開票頁執行，也供單元測試。
//
// 法源對應：
// - 超額（choose）：seats=1 為單一選區相對多數決（§12）；seats>1 且 maxChoices=1 為
//   複數選區單記不可讓渡（§13，學生代表）。兩者計票規則同一套——得票最高依名額順序當選；
//   席次邊界同票時只「標示」，不裁決（§26 由選委會公開抽籤，或另行決議重選）。
// - 同額/不足額（approval）：每位候選人「同意/不同意」，同意 > 不同意才當選。
// - 廢票：明確投廢票（blank）與解不開/不合規的票（invalid）分開計，都算投票率。

import type { BallotChoice, BallotPlain } from "@/lib/ballot-crypto";

export interface TallyInput {
  electionId: string;
  ballotMode: "choose" | "approval";
  seats: number;
  maxChoices: number;
  candidateIds: string[]; // 核准候選人（號次順序）
  plaintexts: (BallotPlain | null)[]; // null＝解不開
  rosterCount: number; // 選舉人總額（投票率分母）
}

export interface CandidateTally {
  candidateId: string;
  votes: number; // choose 模式得票；approval 模式＝同意票
  disagree: number; // 僅 approval 模式使用
  elected: boolean;
  tied: boolean; // choose 模式席次邊界同票，待選委會處理
}

export interface TallyResult {
  mode: "choose" | "approval";
  totalBallots: number; // 票匭總張數（＝有效＋廢票＋無效）
  validCount: number;
  blankCount: number; // 自主廢票
  invalidCount: number; // 解不開/不合規
  rosterCount: number;
  turnoutPct: number; // 0–100，四捨五入到小數 1 位
  candidates: CandidateTally[];
  hasTie: boolean;
}

/**
 * 單張票的 well-formed 判定：choose／approval 兩種模式各自的合規條件。
 * tally.ts（計票）與 disclosure.ts（明細公告）共用同一份，兩處判定不得各寫一套
 * ——否則能構造「有效票數對得上、但沒加給任何候選人」的自洽假結果。
 *
 * - choose：1 ≤ 圈選數 ≤ maxChoices，不重複，且都是本場候選人。
 * - approval：至少一位候選人表態，且都是本場候選人、值為布林。
 */
export function isWellFormedChoice(
  choice: Exclude<BallotChoice, { type: "blank" }>,
  idSet: Set<string>,
  maxChoices: number,
): boolean {
  if (choice.type === "choose") {
    const ids = choice.candidateIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > maxChoices) return false;
    const unique = new Set(ids);
    return unique.size === ids.length && ids.every((id) => idSet.has(id));
  }
  const entries = Object.entries(choice.approvals ?? {});
  return entries.length >= 1 && entries.every(([id, v]) => idSet.has(id) && typeof v === "boolean");
}

export interface CandidateVoteCount {
  candidateId: string;
  votes: number;
  disagree: number; // 僅 approval 模式使用
}

/**
 * 由各候選人得票／不同意票＋席次＋投票模式，決定 elected／tied／hasTie。
 * 純函式：只依賴票數，不信任呼叫端傳來的任何旗標——tallyBallots（本地計票）與
 * submitResults（伺服器重算 client 送來的結果）共用同一份判定，兩處不得各寫一套。
 */
export function decideElected(
  ballotMode: "choose" | "approval",
  seats: number,
  candidates: CandidateVoteCount[],
): { candidates: CandidateTally[]; hasTie: boolean } {
  if (ballotMode === "choose") {
    // 依得票排序取名額；席次邊界同票 → 邊界票數者全標 tied、不判當選
    const ids = candidates.map((c) => c.candidateId);
    const votes = new Map(candidates.map((c) => [c.candidateId, c.votes]));
    const sorted = [...ids].sort((a, b) => votes.get(b)! - votes.get(a)!);
    const boundaryVotes = sorted.length >= seats ? votes.get(sorted[seats - 1])! : -1;
    const hasTie = sorted.length > seats && votes.get(sorted[seats])! === boundaryVotes;
    const result = candidates.map((c) => {
      const v = c.votes;
      const tied = hasTie && v === boundaryVotes;
      const elected = !tied && v > (hasTie ? boundaryVotes : -1) &&
        sorted.indexOf(c.candidateId) < seats;
      return { candidateId: c.candidateId, votes: v, disagree: 0, elected, tied };
    });
    return { candidates: result, hasTie };
  }
  const result = candidates.map((c) => ({
    candidateId: c.candidateId,
    votes: c.votes,
    disagree: c.disagree,
    elected: c.votes > c.disagree,
    tied: false,
  }));
  return { candidates: result, hasTie: false };
}

export function tallyBallots(input: TallyInput): TallyResult {
  const { electionId, ballotMode, seats, maxChoices, candidateIds, plaintexts, rosterCount } =
    input;
  const idSet = new Set(candidateIds);
  const votes = new Map<string, number>(candidateIds.map((id) => [id, 0]));
  const disagrees = new Map<string, number>(candidateIds.map((id) => [id, 0]));
  let blankCount = 0;
  let invalidCount = 0;
  let validCount = 0;

  for (const plain of plaintexts) {
    // 解不開、版本不符、綁錯選舉 → 無效票
    if (!plain || plain.electionId !== electionId) {
      invalidCount++;
      continue;
    }
    const choice = plain.choice;
    if (choice.type === "blank") {
      blankCount++;
      continue;
    }
    if (ballotMode === "choose") {
      if (choice.type !== "choose" || !isWellFormedChoice(choice, idSet, maxChoices)) {
        invalidCount++;
        continue;
      }
      for (const id of choice.candidateIds) votes.set(id, votes.get(id)! + 1);
      validCount++;
    } else {
      if (choice.type !== "approval" || !isWellFormedChoice(choice, idSet, maxChoices)) {
        invalidCount++;
        continue;
      }
      for (const [id, agree] of Object.entries(choice.approvals)) {
        if (agree) votes.set(id, votes.get(id)! + 1);
        else disagrees.set(id, disagrees.get(id)! + 1);
      }
      validCount++;
    }
  }

  const totalBallots = plaintexts.length;
  const turnoutPct =
    rosterCount > 0 ? Math.round((totalBallots / rosterCount) * 1000) / 10 : 0;

  const { candidates, hasTie } = decideElected(
    ballotMode,
    seats,
    candidateIds.map((id) => ({
      candidateId: id,
      votes: votes.get(id)!,
      disagree: disagrees.get(id)!,
    })),
  );

  return {
    mode: ballotMode,
    totalBallots,
    validCount,
    blankCount,
    invalidCount,
    rosterCount,
    turnoutPct,
    candidates,
    hasTie,
  };
}

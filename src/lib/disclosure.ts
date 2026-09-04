// 去識別化的選舉人個別意思（選罷法 §26-1 Ⅳ、Ⅴ）。純函式，無 IO，瀏覽器與 Node 都能跑。
//
// 法條要求「分別記錄投票暨未投票選舉人名冊，及記載可回溯代碼之去識別化選舉人個別意思」，
// 且「本會不得記錄其與個別選舉人之連結」。這裡負責後半段：
// - 代碼＝投票當下就發給選舉人的收據（密文 SHA-256 前 12 碼，見 ballot-crypto.receiptOf）；
// - 意思＝那張票解密後的內容，只有候選人 id，不帶任何身分資訊。
// 連結的斷開不在這個檔案，而是彌封時刪掉 EncryptedBallot（tally/actions.ts）。
//
// verifyDisclosures 讓「沒有私鑰的伺服器」也能驗證選委提交的明細與計票結果自洽：
// 張數、代碼集合、各類票張數、逐票加總的得票數全部要對得上，任一不符就拒收。

import type { BallotPlain } from "@/lib/ballot-crypto";
import type { TallyResult } from "@/lib/tally";

export interface DisclosureEntry {
  code: string; // 12 碼可回溯代碼
  kind: "choose" | "approval" | "blank" | "invalid";
  candidateIds?: string[]; // kind="choose"
  approvals?: Record<string, boolean>; // kind="approval"
}

/**
 * 代碼與明文同索引配對，產出公告用的明細。
 * 輸出依 code 字典序排序：與彌封順序無關，兩個人各自開票應得到逐字相同的清單。
 */
export function buildDisclosures(
  codes: string[],
  plaintexts: (BallotPlain | null)[],
  electionId: string,
  ballotMode: "choose" | "approval",
  candidateIds: string[],
  maxChoices: number,
): DisclosureEntry[] {
  const idSet = new Set(candidateIds);
  const entries = codes.map((code, i) =>
    toEntry(code, plaintexts[i] ?? null, electionId, ballotMode, idSet, maxChoices),
  );
  return entries.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * 單張票的判定，與 tally.ts 的分類規則必須一致（同一份 well-formed 條件），
 * 否則明細與票數會對不起來、verifyDisclosures 就會擋下來。
 */
function toEntry(
  code: string,
  plain: BallotPlain | null,
  electionId: string,
  ballotMode: "choose" | "approval",
  idSet: Set<string>,
  maxChoices: number,
): DisclosureEntry {
  if (!plain || plain.electionId !== electionId) return { code, kind: "invalid" };
  const choice = plain.choice;
  if (choice.type === "blank") return { code, kind: "blank" };

  if (ballotMode === "choose") {
    if (choice.type !== "choose") return { code, kind: "invalid" };
    const ids = choice.candidateIds;
    const unique = new Set(ids);
    const wellFormed =
      Array.isArray(ids) &&
      ids.length >= 1 &&
      ids.length <= maxChoices &&
      unique.size === ids.length &&
      ids.every((id) => idSet.has(id));
    return wellFormed ? { code, kind: "choose", candidateIds: [...ids] } : { code, kind: "invalid" };
  }

  if (choice.type !== "approval") return { code, kind: "invalid" };
  const entries = Object.entries(choice.approvals ?? {});
  const wellFormed =
    entries.length >= 1 && entries.every(([id, v]) => idSet.has(id) && typeof v === "boolean");
  return wellFormed
    ? { code, kind: "approval", approvals: Object.fromEntries(entries) }
    : { code, kind: "invalid" };
}

export type DisclosureMismatch =
  | "count"
  | "codes"
  | "duplicate-code"
  | "class-count"
  | "votes"
  | "max-choices";

/**
 * 交叉驗證：明細必須與票匭代碼集合、以及選委提交的計票結果完全自洽。
 * 回傳 null 代表通過，否則回傳第一個對不上的項目。
 */
export function verifyDisclosures(
  entries: DisclosureEntry[],
  boxCodes: string[],
  results: TallyResult,
  maxChoices: number,
): DisclosureMismatch | null {
  if (entries.length !== boxCodes.length) return "count";

  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.code)) return "duplicate-code";
    seen.add(e.code);
  }
  const boxSet = new Set(boxCodes);
  if (boxSet.size !== seen.size) return "duplicate-code"; // 票匭本身出現重複代碼
  for (const code of seen) if (!boxSet.has(code)) return "codes";

  let blank = 0;
  let invalid = 0;
  let valid = 0;
  const votes = new Map<string, number>();
  const disagrees = new Map<string, number>();
  for (const c of results.candidates) {
    votes.set(c.candidateId, 0);
    disagrees.set(c.candidateId, 0);
  }

  for (const e of entries) {
    if (e.kind === "blank") {
      blank++;
    } else if (e.kind === "invalid") {
      invalid++;
    } else if (e.kind === "choose") {
      const ids = e.candidateIds ?? [];
      if (ids.length > maxChoices) return "max-choices";
      for (const id of ids) {
        if (!votes.has(id)) return "codes"; // 明細出現不在本場名單的候選人
        votes.set(id, votes.get(id)! + 1);
      }
      valid++;
    } else {
      for (const [id, agree] of Object.entries(e.approvals ?? {})) {
        if (!votes.has(id)) return "codes";
        if (agree) votes.set(id, votes.get(id)! + 1);
        else disagrees.set(id, disagrees.get(id)! + 1);
      }
      valid++;
    }
  }

  if (blank !== results.blankCount || invalid !== results.invalidCount || valid !== results.validCount) {
    return "class-count";
  }
  for (const c of results.candidates) {
    if (votes.get(c.candidateId) !== c.votes) return "votes";
    if (disagrees.get(c.candidateId) !== c.disagree) return "votes";
  }
  return null;
}

export const DISCLOSURE_MISMATCH_MESSAGE: Record<DisclosureMismatch, string> = {
  count: "選票明細張數與票匭不符",
  codes: "選票明細的代碼與票匭不符",
  "duplicate-code": "選票明細出現重複代碼",
  "class-count": "選票明細的有效／廢票／無效票張數與計票結果不符",
  votes: "選票明細逐票加總的得票數與計票結果不符",
  "max-choices": "選票明細出現超過可圈選人數的選票",
};

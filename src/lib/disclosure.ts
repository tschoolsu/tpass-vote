// 去識別化的選舉人個別意思（選罷法 §26-1 Ⅳ、Ⅴ）。純函式，無 IO，瀏覽器與 Node 都能跑。
//
// 法條要求「分別記錄投票暨未投票選舉人名冊，及記載可回溯代碼之去識別化選舉人個別意思」，
// 且「本會不得記錄其與個別選舉人之連結」。這裡負責後半段：
// - 代碼＝投票人瀏覽器在投票當下產生、封在加密選票內部的隨機 12 碼；
// - 意思＝那張票解密後的內容，只有候選人 id，不帶任何身分資訊。
// 連結的斷開有兩層：代碼只有持鑰者解得出來（伺服器算不出），加上彌封時刪掉
// EncryptedBallot（tally/actions.ts）。
//
// ⚠️ 代碼改由瀏覽器產生之後，伺服器「失去了『代碼集合與票匭相符』這項對帳」——
// 它看不到密文裡的代碼，無從現算。保留下來的是張數相符，以及明細內部的自洽
// （代碼不重複、各類票張數與逐票加總的得票數與計票結果對得上）。
// 這是刻意的取捨：換掉的是「彌封前任何有 EncryptedBallot 讀權限者，單獨一人即可
// 建 voterId↔代碼對照表、與公告後的 disclosures CSV join 出誰投給誰」。
// 造假結果的防線因此完全落在「兩位選委各自獨立開票比對」（docs/election-sop.md）。

import type { BallotPlain } from "@/lib/ballot-crypto";
import { isWellFormedChoice, type TallyResult } from "@/lib/tally";

export interface DisclosureEntry {
  code: string; // 12 碼可回溯代碼
  kind: "choose" | "approval" | "blank" | "invalid";
  candidateIds?: string[]; // kind="choose"
  approvals?: Record<string, boolean>; // kind="approval"
}

/** 明細排序的唯一標準：依 code 字典序，跟彌封／提交順序無關。 */
export function compareByCode(a: DisclosureEntry, b: DisclosureEntry): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
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
  return entries.sort(compareByCode);
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
    if (choice.type !== "choose" || !isWellFormedChoice(choice, idSet, maxChoices)) {
      return { code, kind: "invalid" };
    }
    return { code, kind: "choose", candidateIds: [...choice.candidateIds] };
  }

  if (choice.type !== "approval" || !isWellFormedChoice(choice, idSet, maxChoices)) {
    return { code, kind: "invalid" };
  }
  return { code, kind: "approval", approvals: { ...choice.approvals } };
}

export type DisclosureMismatch =
  | "count"
  | "codes"
  | "duplicate-code"
  | "class-count"
  | "votes"
  | "max-choices"
  | "malformed"
  | "kind-mismatch";

/**
 * 交叉驗證：明細必須與票匭張數、以及選委提交的計票結果完全自洽。
 * 回傳 null 代表通過，否則回傳第一個對不上的項目。
 *
 * ⚠️ 前提：呼叫端必須先把 `results.mode` 與本場選舉的真實 ballotMode（DB 讀出，
 * 不是提交者填的）比對過，本函式才驗這裡開始的 kind/mode 一致性才有意義——否則
 * 提交者只要把 results.mode 一起改成跟偽造明細一致，這裡的 kind-mismatch 判定
 * 就形同虛設。唯一的生產呼叫點 `tally/actions.ts` 的 `submitResults` 已在呼叫
 * 前做了這項比對，見那裡的註解。
 */
export function verifyDisclosures(
  entries: DisclosureEntry[],
  boxSize: number,
  results: TallyResult,
  maxChoices: number,
): DisclosureMismatch | null {
  if (entries.length !== boxSize) return "count";

  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.code)) return "duplicate-code";
    seen.add(e.code);
  }

  let blank = 0;
  let invalid = 0;
  let valid = 0;
  const votes = new Map<string, number>();
  const disagrees = new Map<string, number>();
  for (const c of results.candidates) {
    votes.set(c.candidateId, 0);
    disagrees.set(c.candidateId, 0);
  }
  const idSet = new Set(votes.keys());

  for (const e of entries) {
    if (e.kind === "blank") {
      blank++;
    } else if (e.kind === "invalid") {
      invalid++;
    } else if (e.kind === "choose") {
      // 明細自稱的 kind 必須與本場計票結果宣告的 mode 一致，否則能拿 approval 明細
      // （較寬鬆、不受 maxChoices 限制）套進 choose 場，繞過下面這整套 choose 判定。
      if (results.mode !== "choose") return "kind-mismatch";
      const ids = e.candidateIds ?? [];
      if (ids.length > maxChoices) return "max-choices";
      if (!ids.every((id) => idSet.has(id))) return "codes"; // 明細出現不在本場名單的候選人
      if (!isWellFormedChoice({ type: "choose", candidateIds: ids }, idSet, maxChoices)) {
        return "malformed"; // 空白圈選或單張票內重複圈選，不是有效票
      }
      for (const id of ids) votes.set(id, votes.get(id)! + 1);
      valid++;
    } else {
      if (results.mode !== "approval") return "kind-mismatch";
      const approvals = e.approvals ?? {};
      if (!Object.keys(approvals).every((id) => idSet.has(id))) return "codes";
      if (!isWellFormedChoice({ type: "approval", approvals }, idSet, maxChoices)) {
        return "malformed"; // 沒有任何候選人表態，不是有效票
      }
      for (const [id, agree] of Object.entries(approvals)) {
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
  codes: "選票明細出現不在本場核准名單內的候選人",
  "duplicate-code": "選票明細出現重複代碼",
  "class-count": "選票明細的有效／廢票／無效票張數與計票結果不符",
  votes: "選票明細逐票加總的得票數與計票結果不符",
  "max-choices": "選票明細出現超過可圈選人數的選票",
  malformed: "選票明細出現空白圈選、重複圈選或無人表態卻標記為有效票",
  "kind-mismatch": "選票明細的種類與本場計票結果宣告的模式不符",
};

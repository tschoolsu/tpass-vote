// 投票資格判定（純函式，無 IO），供 castBallot server action 與單元測試共用。

/**
 * 收票時額外原值改寫幾列不相干的資料。定義在這裡而不是 castBallot 旁邊，是因為
 * `"use server"` 檔案只能匯出 async function，常數匯不出去、測試也就讀不到。
 *
 * 拿掉 voterId 還不足以讓「誰投哪張」消失：Postgres 每一列都有隱藏系統欄位 xmin＝
 * 寫入該列版本的交易 id，而 Voter.hasVoted 與票是同一個交易寫的，所以
 *
 *   SELECT b.xmin, v.email FROM "EncryptedBallot" b JOIN "Voter" v ON b.xmin = v.xmin;
 *
 * 一句話就能精確還原。拆成兩個交易也沒用——xid 單調遞增，排序 rank-join 的資訊量
 * 跟被砍掉的 votedAt 時間戳等價。
 *
 * 對策是讓同一個 xid 落在多列上：收票時順便對 K 個其他選舉人與 K 張其他票做值不變的
 * UPDATE（Postgres 不會省略 no-op UPDATE，照樣寫出帶本交易 xid 的新 tuple 版本），
 * 精確 join 於是退化成「這 K+1 個人裡的某一個」。
 *
 * 但擾動是**稀釋不是消滅**：後來的票會覆蓋前面留下的 xid，侵蝕到最後約 1.5% 的選舉人
 * 會剩下「這個 xid 只對到你一個人、也只對到一張票」——那一票就被精確還原了，而且這個
 * 比例與名冊大小無關（模擬 N=64／200／800／3000 都是 1.4～1.5%）。真正把這條通道歸零
 * 的是**關票時的塌縮**（advanceStatus 推進到 closed 時整場原值改寫一次，全部的列從此
 * 帶同一個 xid），所以「已關票」之後的任何快照都乾淨。
 *
 * 於是還擋不住的只剩**投票當下就在即時監看資料庫**的人。這條邊界寫在
 * README〈防護邊界（誠實版）〉與 docs/election-sop.md，對策是存取控制不是程式碼。
 *
 * K 越大越安全也越塞：每個收票交易會多握 K+1 個列鎖。要調整前先跑 pnpm stress。
 */
export const PERTURB_K = 16;

export interface CastElectionState {
  status: string;
  votingStartsAt: Date | null;
  votingEndsAt: Date | null;
}

// "already-voted" 不由 castDecision 判定：那件事只有在鎖內讀到 Voter.hasVoted 才算數，
// 純函式看不到、也不該假裝看得到。它只存在於這個聯集與下面的訊息表裡，由 castBallot 直接丟出。
export type CastRejection = "not-open" | "not-started" | "ended" | "not-in-roster" | "already-voted";

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
  "already-voted": "你已經投過票了，本場選舉每人只能投一次，選票送出後無法更改或撤回",
};

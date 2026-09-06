"use server";
// 彌封與開票結果回傳。安全不變量：
// 1. 彌封＝去識別＋密碼學洗牌後的密文快照（sealedBox），此後計票一律以快照為準，
//    快照與其雜湊公開，任何持鑰者可重複驗算。彌封同時刪除 EncryptedBallot，
//    讓「代碼↔選舉人」的連結不留存（§26-1 Ⅳ）。
// 2. 解密與計票發生在「選委瀏覽器本地」，伺服器沒有私鑰、無從驗證內容，
//    只驗「張數與票匭一致」；防偽靠公開快照＋可重複計票，不靠信任單一提交。
// 3. 狀態機只能單向前進：closed → sealed；結果提交不改狀態（發結果公告才 published）。

import { randomInt, createHash } from "node:crypto";
import { z } from "zod";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { authConfig } from "@/config/auth";
import { resultAnnouncementDraft, type ResultCandidateInfo } from "@/lib/result-announcement";
import { cloneElection } from "@/lib/clone-election";
import { recallPassed } from "@/lib/recall";
import { verifyDisclosures, DISCLOSURE_MISMATCH_MESSAGE } from "@/lib/disclosure";
import { decideElected } from "@/lib/tally";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function sealElection(electionId: string): Promise<ActionResult> {
  const admin = await requireAdmin();

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (election.status !== "closed") {
    return { ok: false, error: "只有已截止（closed）的選舉才能彌封" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 收票（castBallot）對這一列取 FOR SHARE，這裡取 FOR UPDATE 與之互斥。
      // 票匭快照「必須」在鎖之後才讀：讀在交易外的話，一張正在落地的票會落在
      // 快照與 deleteMany 之間——被刪掉、卻不在快照裡。投票人收到 ok，票卻永久
      // 消失，不計票也查不出來。這是彌封路徑上最不可偵測的一種失敗。
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM "Election" WHERE id = ${electionId} FOR UPDATE
      `;
      if (!locked || locked.status !== "closed") throw new Error("CONFLICT");

      const ballots = await tx.encryptedBallot.findMany({
        where: { electionId },
        select: { ciphertext: true },
      });

      // Fisher–Yates（node:crypto randomInt，非 Math.random）：
      // 快照順序必須與寫入順序無關，否則洗牌形同虛設。
      const box = ballots.map((b) => b.ciphertext);
      for (let i = box.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [box[i], box[j]] = [box[j], box[i]];
      }

      const sealedHash = createHash("sha256").update(JSON.stringify(box)).digest("hex");

      const sealed = await tx.election.updateMany({
        where: { id: electionId, status: "closed" }, // 樂觀鎖：與上面的列鎖雙保險
        data: {
          sealedBox: box,
          sealedHash,
          sealedAt: new Date(),
          sealedBy: admin.email,
          status: "sealed",
        },
      });
      // 樂觀鎖沒搶到就 throw 讓整個交易回滾——不能只 return，否則下面的刪除會照跑。
      if (sealed.count === 0) throw new Error("CONFLICT");

      // §26-1 Ⅳ：本會不得記錄可回溯代碼與個別選舉人之連結。密文已全數進入洗牌後的
      // sealedBox，這裡把 voterId↔ciphertext 的對應永久刪掉；名冊（Voter.votedAt）保留。
      await tx.encryptedBallot.deleteMany({ where: { electionId } });
    }, { timeout: 10_000 });
  } catch (e) {
    if (e instanceof Error && e.message === "CONFLICT") {
      return { ok: false, error: "選舉狀態已被其他選委變更，請重新整理頁面" };
    }
    throw e;
  }

  return { ok: true };
}

// 結果結構驗證：形狀對、數字非負即可——內容正確性由公開快照＋重複計票保證。
const tallyResultSchema = z.object({
  mode: z.enum(["choose", "approval"]),
  totalBallots: z.number().int().nonnegative(),
  validCount: z.number().int().nonnegative(),
  blankCount: z.number().int().nonnegative(),
  invalidCount: z.number().int().nonnegative(),
  rosterCount: z.number().int().nonnegative(),
  turnoutPct: z.number().min(0).max(100),
  candidates: z.array(
    z.object({
      candidateId: z.string(),
      votes: z.number().int().nonnegative(),
      disagree: z.number().int().nonnegative(),
      elected: z.boolean(),
      tied: z.boolean(),
    }),
  ),
  hasTie: z.boolean(),
});

// 去識別化選票明細（§26-1 Ⅳ）：只有代碼與意思，不得出現任何身分欄位。
const disclosureSchema = z.array(
  z.object({
    code: z.string().regex(/^[0-9a-f]{12}$/, "代碼格式不正確"),
    kind: z.enum(["choose", "approval", "blank", "invalid"]),
    candidateIds: z.array(z.string()).optional(),
    approvals: z.record(z.string(), z.boolean()).optional(),
  }),
);

export async function submitResults(
  electionId: string,
  results: unknown,
  disclosures: unknown,
): Promise<ActionResult> {
  const admin = await requireAdmin();

  const parsed = tallyResultSchema.safeParse(results);
  if (!parsed.success) return { ok: false, error: "計票結果格式不正確" };
  const r = parsed.data;

  const parsedDisclosures = disclosureSchema.safeParse(disclosures);
  if (!parsedDisclosures.success) return { ok: false, error: "選票明細格式不正確" };

  const election = await prisma.election.findUnique({
    where: { id: electionId },
    include: {
      candidates: { where: { status: "approved" }, select: { id: true, number: true, members: true } },
    },
  });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (election.status !== "sealed") return { ok: false, error: "選舉尚未彌封，不能提交結果" };
  const isResubmit = election.resultsJson != null;

  // ballotMode 是本場選舉的真相（advanceStatus 推進到 voting 時定案，狀態機單向前進到
  // sealed 必定已設定），不能信任提交者填的 r.mode——r.mode 只做過 enum 格式檢查，
  // 攻擊者可以填一個跟真實模式不符、卻跟自己偽造的明細自洽的值，讓 verifyDisclosures
  // 內部「kind 必須與 results.mode 一致」的判定形同虛設（見 disclosure.ts 的說明）。
  if (election.ballotMode !== "choose" && election.ballotMode !== "approval") {
    return { ok: false, error: "本場選舉尚未確定投票模式，無法提交結果" };
  }
  if (r.mode !== election.ballotMode) {
    return { ok: false, error: "計票結果宣告的模式與本場選舉不符" };
  }

  const box = Array.isArray(election.sealedBox) ? (election.sealedBox as string[]) : [];
  const boxSize = box.length;
  if (r.totalBallots !== boxSize) {
    return { ok: false, error: `張數不符：票匭 ${boxSize} 張、計票 ${r.totalBallots} 張` };
  }
  if (r.validCount + r.blankCount + r.invalidCount !== r.totalBallots) {
    return { ok: false, error: "有效＋廢票＋無效 與總張數不符" };
  }

  const approvedIds = new Set(election.candidates.map((c) => c.id));
  const submittedIds = new Set(r.candidates.map((c) => c.candidateId));
  if (
    approvedIds.size !== submittedIds.size ||
    [...approvedIds].some((id) => !submittedIds.has(id))
  ) {
    return { ok: false, error: "候選人清單與本場核准名單不符" };
  }
  // Set 比對只看「有沒有出現過」，同一位候選人出現兩次會被 Set 吃掉、繞過上面的檢查，
  // 拿一份「重複計某人一次」的清單自洽提交。這裡另外擋陣列長度。
  if (r.candidates.length !== approvedIds.size) {
    return { ok: false, error: "候選人清單出現重複" };
  }

  // 代碼封在密文內部（投票人瀏覽器產生），伺服器沒有私鑰就算不出來——「代碼集合與
  // 票匭相符」這項對帳已經不成立，換到的是「單一 DB 讀權限者無法自建對照表」。
  // 剩下的自洽檢查照舊：張數、代碼不重複、各類票張數、逐票加總的得票數。
  // 造假結果的防線在「兩位選委各自獨立開票比對」（docs/election-sop.md）。
  const mismatch = verifyDisclosures(parsedDisclosures.data, boxSize, r, election.maxChoices);
  if (mismatch) {
    return { ok: false, error: `${DISCLOSURE_MISMATCH_MESSAGE[mismatch]}，已拒絕提交` };
  }

  // 上面通過的只是「形狀對＋跟明細自洽」——elected／tied／hasTie／rosterCount／
  // turnoutPct 是 client 算出來的判定，伺服器沒有重算過就直接信了。verifyDisclosures
  // 只驗票數（有幾票、投給誰），不驗「誰該當選」；當選與否是票數＋席次＋模式的
  // 純函式，伺服器自己就能算，不必信任提交者。這裡用 decideElected 重算一遍，
  // 寫進 DB 的一律是伺服器算出的值。
  const rosterCount = await prisma.voter.count({ where: { electionId } });
  const turnoutPct = rosterCount > 0 ? Math.round((r.totalBallots / rosterCount) * 1000) / 10 : 0;
  const decided = decideElected(
    election.ballotMode,
    election.seats,
    r.candidates.map((c) => ({ candidateId: c.candidateId, votes: c.votes, disagree: c.disagree })),
  );
  // client 送來的旗標若與伺服器重算不一致，不拒收（避免舊瀏覽器快取卡住提交），
  // 但在稽核紀錄留一筆，方便事後追查是不是有人動了手腳。
  const clientMismatch =
    r.rosterCount !== rosterCount ||
    r.turnoutPct !== turnoutPct ||
    r.hasTie !== decided.hasTie ||
    decided.candidates.some(
      (c, i) => c.elected !== r.candidates[i].elected || c.tied !== r.candidates[i].tied,
    );
  const finalResults = {
    ...r,
    rosterCount,
    turnoutPct,
    candidates: decided.candidates,
    hasTie: decided.hasTie,
  };

  // 提交計票結果後，於同一流程自動生成／更新 legalTag='result' 的公告草稿，
  // 讓選委直接到「結果公告」面板小編後發布，不必自己從零寫。已發布過的 result
  // 公告不會被這裡覆寫（只有草稿——publishedAt 為 null——才會被改寫內容）。
  const candidatesForDraft: ResultCandidateInfo[] = election.candidates.map((c) => ({
    id: c.id,
    number: c.number,
    members: Array.isArray(c.members) ? (c.members as unknown as ResultCandidateInfo["members"]) : [],
  }));
  const draft = resultAnnouncementDraft(
    {
      title: election.title,
      kind: election.kind,
      seats: election.seats,
      resultsUrl: new URL(`/e/${election.slug}/results`, authConfig.selfUrl).toString(),
    },
    finalResults,
    candidatesForDraft,
  );

  await prisma.$transaction(async (tx) => {
    await tx.election.update({
      where: { id: electionId },
      data: {
        resultsJson: finalResults as unknown as Prisma.InputJsonValue,
        disclosuresJson: parsedDisclosures.data,
      },
    });

    await tx.electionAuditLog.create({
      data: {
        electionId,
        actorEmail: admin.email,
        action: "submit_results",
        summary: isResubmit ? "重新提交計票結果（覆寫舊結果）" : "提交計票結果",
        diff: {
          resubmit: isResubmit,
          totalBallots: finalResults.totalBallots,
          validCount: finalResults.validCount,
          blankCount: finalResults.blankCount,
          invalidCount: finalResults.invalidCount,
          electedCount: finalResults.candidates.filter((c) => c.elected).length,
          hasTie: finalResults.hasTie,
          clientMismatch,
        } as Prisma.InputJsonValue,
      },
    });

    const existingResultAnnouncement = await tx.announcement.findFirst({
      where: { electionId, legalTag: "result" },
    });
    if (!existingResultAnnouncement) {
      await tx.announcement.create({
        data: { electionId, legalTag: "result", title: draft.title, body: draft.body },
      });
    } else if (!existingResultAnnouncement.publishedAt) {
      await tx.announcement.update({
        where: { id: existingResultAnnouncement.id },
        data: { title: draft.title, body: draft.body },
      });
    }

    // 罷免通過 → 同一交易內自動生成補選草稿（以罷免案的 parent＝原職位選舉為本）。
    // 防重複：parent 底下已有 lineage='by_election' 的子場就跳過，不重複建立。
    const target = finalResults.candidates[0];
    if (election.kind === "recall" && election.parentId && target && recallPassed(target.votes, target.disagree)) {
      const existingByElection = await tx.election.findFirst({
        where: { parentId: election.parentId, lineage: "by_election" },
        select: { id: true },
      });
      if (!existingByElection) {
        const parent = await tx.election.findUnique({ where: { id: election.parentId } });
        if (parent) {
          await cloneElection(tx, parent, {
            lineage: "by_election",
            titleSuffix: "（補選）",
            copyCandidates: "none",
            copyRoster: true,
          });
        }
      }
    }
  }, { timeout: 10_000 });

  return { ok: true };
}

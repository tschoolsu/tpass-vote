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
import { receiptOf } from "@/lib/ballot-crypto";
import { verifyDisclosures, DISCLOSURE_MISMATCH_MESSAGE } from "@/lib/disclosure";

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

  // 伺服器沒有私鑰、看不到任何一張選票內容，但可以就公開的彌封快照現算代碼，
  // 再用明細與計票結果互相對帳——不自洽就拒收，不靠信任單一提交。
  const boxCodes = await Promise.all(box.map((ciphertext) => receiptOf(ciphertext)));
  const mismatch = verifyDisclosures(parsedDisclosures.data, boxCodes, r, election.maxChoices);
  if (mismatch) {
    return { ok: false, error: `${DISCLOSURE_MISMATCH_MESSAGE[mismatch]}，已拒絕提交` };
  }

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
    r,
    candidatesForDraft,
  );

  await prisma.$transaction(async (tx) => {
    await tx.election.update({
      where: { id: electionId },
      data: { resultsJson: r, disclosuresJson: parsedDisclosures.data },
    });

    await tx.electionAuditLog.create({
      data: {
        electionId,
        actorEmail: admin.email,
        action: "submit_results",
        summary: isResubmit ? "重新提交計票結果（覆寫舊結果）" : "提交計票結果",
        diff: {
          resubmit: isResubmit,
          totalBallots: r.totalBallots,
          validCount: r.validCount,
          blankCount: r.blankCount,
          invalidCount: r.invalidCount,
          electedCount: r.candidates.filter((c) => c.elected).length,
          hasTie: r.hasTie,
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
    const target = r.candidates[0];
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

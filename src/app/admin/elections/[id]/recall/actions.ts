"use server";
// 罷免案（kind="recall"）管理端 server actions：提起、成立、駁回、答辯書。
// 罷免鏈：petition（連署中）→ established（已成立，等開票金鑰）→ voting → closed → sealed → published，
// voting 之後與一般選舉共用既有 sealElection / submitResults / 公告發布流程，不在這裡。
//
// 法源對應：
// - §28：會長副會長罷免案提出，應有當屆有效票總數 2/5 以上之連署（門檻＝src/lib/recall.ts）。
// - §36：同意罷免票數多於不同意罷免票數者，通過。
// - §37：罷免案否決後，同一事由不得再為罷免案之提出（此處只做「軟警告」，不擋，由選委自行判斷）。
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { recallThreshold, recallPassed } from "@/lib/recall";
import type { TallyResult } from "@/lib/tally";

export type ActionResult = { ok: true } | { ok: false; error: string };

export type CreateRecallResult =
  | { ok: true; electionId: string; warnings: string[] }
  | { ok: false; error: string };

export async function createRecall(
  parentId: string,
  targetCandidateId: string,
  reason: string,
): Promise<CreateRecallResult> {
  const admin = await requireAdmin();

  const trimmedReason = reason.trim();
  if (trimmedReason === "") return { ok: false, error: "請填寫罷免事由" };

  const parent = await prisma.election.findUnique({
    where: { id: parentId },
    include: { candidates: { where: { id: targetCandidateId } } },
  });
  if (!parent) return { ok: false, error: "找不到原選舉" };
  if (parent.status !== "published") {
    return { ok: false, error: "只有已公告結果的選舉才能對其候選人提起罷免" };
  }

  const targetCandidate = parent.candidates[0];
  if (!targetCandidate) return { ok: false, error: "找不到罷免對象（候選人組不屬於本場選舉）" };

  if (!parent.resultsJson) return { ok: false, error: "原選舉尚無計票結果" };
  const parentResults = parent.resultsJson as unknown as TallyResult;
  const targetResult = parentResults.candidates?.find((c) => c.candidateId === targetCandidateId);
  if (!targetResult?.elected) {
    return { ok: false, error: "此候選人（組）未當選，無法對其提起罷免" };
  }

  const warnings: string[] = [];

  // 軟警告①：就職未滿 2 個月（用原選舉 result 公告的發布時間近似就職日）。
  const resultAnnouncement = await prisma.announcement.findFirst({
    where: { electionId: parent.id, legalTag: "result", publishedAt: { not: null } },
  });
  if (resultAnnouncement?.publishedAt) {
    const twoMonthsAfter = new Date(resultAnnouncement.publishedAt);
    twoMonthsAfter.setMonth(twoMonthsAfter.getMonth() + 2);
    if (new Date() < twoMonthsAfter) {
      warnings.push("此候選人（組）就職未滿 2 個月，請確認是否符合罷免提起時機的規定。");
    }
  }

  // 軟警告②：同 parent＋同 targetCandidateId 已有被否決的罷免案（§37 同事由限制，由選委自行判斷）。
  const siblings = await prisma.election.findMany({
    where: { parentId: parent.id, kind: "recall", recallTargetCandidateId: targetCandidateId },
    select: { resultsJson: true },
  });
  const hasRejectedBefore = siblings.some((s) => {
    if (!s.resultsJson) return false;
    const res = s.resultsJson as unknown as TallyResult;
    const c = res.candidates?.[0];
    if (!c) return false;
    return !recallPassed(c.votes, c.disagree);
  });
  if (hasRejectedBefore) {
    warnings.push("此對象曾有罷免案被否決，依§37同一事由不得再提罷免，請確認本次事由是否相同。");
  }

  const recall = await prisma.$transaction(async (tx) => {
    let newSlug = `${parent.slug}-recall`;
    let n = 2;
    while (await tx.election.findUnique({ where: { slug: newSlug }, select: { id: true } })) {
      newSlug = `${parent.slug}-recall-${n}`;
      n++;
    }

    const created = await tx.election.create({
      data: {
        slug: newSlug,
        title: `${parent.title}罷免案`,
        kind: "recall",
        parentId: parent.id,
        status: "petition",
        ballotMode: "approval",
        seats: 1,
        maxChoices: 1,
        recallReason: trimmedReason,
        recallTargetCandidateId: targetCandidateId,
      },
    });

    const voters = await tx.voter.findMany({
      where: { electionId: parent.id },
      select: { email: true, name: true },
    });
    if (voters.length > 0) {
      await tx.voter.createMany({
        data: voters.map((v) => ({ electionId: created.id, email: v.email, name: v.name })),
      });
    }

    await tx.candidate.create({
      data: {
        electionId: created.id,
        members: targetCandidate.members as Prisma.InputJsonValue,
        number: 1,
        platform: "",
        status: "approved",
        createdBy: admin.email,
      },
    });

    return created;
  });

  revalidatePath("/admin");
  return { ok: true, electionId: recall.id, warnings };
}

export async function establishRecall(id: string): Promise<ActionResult> {
  await requireAdmin();

  const election = await prisma.election.findUnique({ where: { id } });
  if (!election) return { ok: false, error: "找不到罷免案" };
  if (election.status !== "petition") return { ok: false, error: "只有連署期間的罷免案才能推進到已成立" };
  if (!election.parentId) return { ok: false, error: "罷免案缺少原選舉關聯" };

  const parent = await prisma.election.findUnique({
    where: { id: election.parentId },
    select: { resultsJson: true },
  });
  if (!parent?.resultsJson) return { ok: false, error: "原選舉尚無計票結果，無法計算連署門檻" };
  const parentResults = parent.resultsJson as unknown as TallyResult;
  const threshold = recallThreshold(parentResults.validCount);

  const count = await prisma.recallSignature.count({ where: { electionId: id } });
  if (count < threshold) {
    return { ok: false, error: `連署數 ${count} 未達門檻 ${threshold}，無法成立罷免案` };
  }

  const updated = await prisma.election.updateMany({
    where: { id, status: "petition" }, // 樂觀鎖：防兩個選委同時推進
    data: { status: "established" },
  });
  if (updated.count === 0) {
    return { ok: false, error: "狀態已被其他選委變更，請重新整理頁面" };
  }

  revalidatePath(`/admin/elections/${id}`);
  revalidatePath("/admin");
  return { ok: true };
}

// petition 期間駁回：軟刪除（hiddenAt），資料完全保留。reason 目前僅供呼叫端顯示/記錄用途，
// schema 尚無專屬留痕欄位，不寫入 DB（若未來要稽核追蹤，需另加欄位，不在本階段範圍）。
export async function rejectRecall(id: string, reason?: string): Promise<ActionResult> {
  await requireAdmin();
  void reason;

  const election = await prisma.election.findUnique({ where: { id } });
  if (!election) return { ok: false, error: "找不到罷免案" };
  if (election.status !== "petition") return { ok: false, error: "只有連署期間的罷免案才能駁回" };
  if (election.hiddenAt) return { ok: false, error: "此罷免案已經是隱藏狀態" };

  await prisma.election.update({ where: { id }, data: { hiddenAt: new Date() } });

  revalidatePath(`/admin/elections/${id}`);
  revalidatePath("/admin");
  return { ok: true };
}

export async function saveRecallDefense(id: string, text: string): Promise<ActionResult> {
  await requireAdmin();

  const election = await prisma.election.findUnique({ where: { id } });
  if (!election) return { ok: false, error: "找不到罷免案" };
  if (election.status !== "established") {
    return { ok: false, error: "只有已成立的罷免案才能提交答辯書" };
  }

  await prisma.election.update({ where: { id }, data: { recallDefense: text } });

  revalidatePath(`/admin/elections/${id}`);
  return { ok: true };
}

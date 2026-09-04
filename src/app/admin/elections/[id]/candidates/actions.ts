"use server";
// 候選人審核。投票開始後（status ∈ voting 之後）名單鎖定，避免核准/拒絕動作在票已經開出後
// 改變 approved 候選人集合，弄亂已經定案的 ballotMode 與票匭內容假設。
//
// 編號規則：不手動設定，改按「已核准候選人的登記時間（createdAt）由早到晚」自動分配 1..N；
// 非 approved 一律 number=null，不佔號、不留空號。任何會改變 status 的 action 成功後都要
// 呼叫 renumberApproved 重算一次。
import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { LOCKED_STATUSES } from "@/lib/election-status";

export type ActionResult = { ok: true } | { ok: false; error: string };

async function assertElectionEditable(electionId: string): Promise<ActionResult | null> {
  const election = await prisma.election.findUnique({ where: { id: electionId }, select: { status: true } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (LOCKED_STATUSES.has(election.status)) return { ok: false, error: "投票已開始，候選人名單已鎖定" };
  return null;
}

// 先把整場選舉的候選人編號全清空（NULL 在唯一索引裡互不衝突，不會撞號），
// 再依 createdAt 升冪對已核准者重新排 1..N——避免「先設目標號次」時跟其他候選人現有號次暫時衝突。
async function renumberApproved(tx: Prisma.TransactionClient, electionId: string): Promise<void> {
  await tx.candidate.updateMany({ where: { electionId }, data: { number: null } });
  const approved = await tx.candidate.findMany({
    where: { electionId, status: "approved" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  for (let i = 0; i < approved.length; i++) {
    await tx.candidate.update({ where: { id: approved[i].id }, data: { number: i + 1 } });
  }
}

export async function approveCandidate(electionId: string, candidateId: string): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}/candidates`);
  const blocked = await assertElectionEditable(electionId);
  if (blocked) return blocked;

  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.electionId !== electionId) return { ok: false, error: "找不到候選人" };

  await prisma.$transaction(async (tx) => {
    await tx.candidate.update({ where: { id: candidateId }, data: { status: "approved" } });
    await renumberApproved(tx, electionId);
  }, { timeout: 10_000 });
  revalidatePath(`/admin/elections/${electionId}/candidates`);
  revalidatePath(`/admin/elections/${electionId}`);
  return { ok: true };
}

export async function sendBackForFix(
  electionId: string,
  candidateId: string,
  reviewNote: string,
): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}/candidates`);
  const blocked = await assertElectionEditable(electionId);
  if (blocked) return blocked;

  const note = reviewNote.trim();
  if (note === "") return { ok: false, error: "退回補正需要填寫審核意見" };

  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.electionId !== electionId) return { ok: false, error: "找不到候選人" };

  await prisma.$transaction(async (tx) => {
    await tx.candidate.update({
      where: { id: candidateId },
      data: { status: "needs_fix", reviewNote: note },
    });
    await renumberApproved(tx, electionId);
  }, { timeout: 10_000 });
  revalidatePath(`/admin/elections/${electionId}/candidates`);
  return { ok: true };
}

export async function rejectCandidate(
  electionId: string,
  candidateId: string,
  reviewNote?: string,
): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}/candidates`);
  const blocked = await assertElectionEditable(electionId);
  if (blocked) return blocked;

  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.electionId !== electionId) return { ok: false, error: "找不到候選人" };

  await prisma.$transaction(async (tx) => {
    await tx.candidate.update({
      where: { id: candidateId },
      data: { status: "rejected", reviewNote: reviewNote?.trim() || null },
    });
    await renumberApproved(tx, electionId);
  }, { timeout: 10_000 });
  revalidatePath(`/admin/elections/${electionId}/candidates`);
  revalidatePath(`/admin/elections/${electionId}`);
  return { ok: true };
}

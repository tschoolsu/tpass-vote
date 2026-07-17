"use server";
// 候選人審核。投票開始後（status ∈ voting 之後）名單鎖定，避免核准/拒絕動作在票已經開出後
// 改變 approved 候選人集合，弄亂已經定案的 ballotMode 與票匭內容假設。
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";

const LOCKED_STATUSES = new Set(["voting", "closed", "sealed", "published"]);

export type ActionResult = { ok: true } | { ok: false; error: string };

async function assertElectionEditable(electionId: string): Promise<ActionResult | null> {
  const election = await prisma.election.findUnique({ where: { id: electionId }, select: { status: true } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (LOCKED_STATUSES.has(election.status)) return { ok: false, error: "投票已開始，候選人名單已鎖定" };
  return null;
}

const numberSchema = z.coerce.number().int("編號須為正整數").positive("編號須為正整數");

export async function setCandidateNumber(
  electionId: string,
  candidateId: string,
  number: number,
): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}/candidates`);
  const blocked = await assertElectionEditable(electionId);
  if (blocked) return blocked;

  const parsed = numberSchema.safeParse(number);
  if (!parsed.success) return { ok: false, error: "編號須為正整數" };

  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.electionId !== electionId) return { ok: false, error: "找不到候選人" };

  try {
    await prisma.candidate.update({ where: { id: candidateId }, data: { number: parsed.data } });
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
      return { ok: false, error: "這個編號已被其他候選人使用" };
    }
    throw e;
  }

  revalidatePath(`/admin/elections/${electionId}/candidates`);
  return { ok: true };
}

export async function approveCandidate(electionId: string, candidateId: string): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}/candidates`);
  const blocked = await assertElectionEditable(electionId);
  if (blocked) return blocked;

  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.electionId !== electionId) return { ok: false, error: "找不到候選人" };
  if (candidate.number === null) return { ok: false, error: "請先設定編號再核准" };

  await prisma.candidate.update({ where: { id: candidateId }, data: { status: "approved" } });
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

  await prisma.candidate.update({
    where: { id: candidateId },
    data: { status: "needs_fix", reviewNote: note },
  });
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

  await prisma.candidate.update({
    where: { id: candidateId },
    data: { status: "rejected", reviewNote: reviewNote?.trim() || null },
  });
  revalidatePath(`/admin/elections/${electionId}/candidates`);
  revalidatePath(`/admin/elections/${electionId}`);
  return { ok: true };
}

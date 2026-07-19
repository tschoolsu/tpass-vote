"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { parseElectionForm, type ElectionFormResult } from "@/app/admin/elections/election-schema";
import { LOCKED_STATUSES } from "@/lib/election-status";

// 投票開始後（含之後的每個狀態）選舉基本資料一律鎖定，避免改動 seats/maxChoices
// 弄亂已經定案的 ballotMode 判定或已公告的期程。

export async function updateElection(
  electionId: string,
  _prev: ElectionFormResult | null,
  formData: FormData,
): Promise<ElectionFormResult> {
  await requireAdmin(`/admin/elections/${electionId}/edit`);

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (LOCKED_STATUSES.has(election.status)) {
    return { ok: false, error: "投票已開始，選舉基本資料已鎖定，不可再修改" };
  }

  const parsed = parseElectionForm(formData);
  if (!parsed.ok) return parsed.result;
  const v = parsed.data;

  if (v.slug !== election.slug) {
    const existing = await prisma.election.findUnique({ where: { slug: v.slug }, select: { id: true } });
    if (existing) {
      return { ok: false, error: "這個 slug 已被使用", fieldErrors: { slug: "已被使用" } };
    }
  }

  await prisma.election.update({
    where: { id: electionId },
    data: {
      title: v.title,
      slug: v.slug,
      kind: v.kind,
      seats: v.seats,
      maxChoices: v.maxChoices,
      registrationStartsAt: v.registrationStartsAt ?? null,
      registrationEndsAt: v.registrationEndsAt ?? null,
      votingStartsAt: v.votingStartsAt ?? null,
      votingEndsAt: v.votingEndsAt ?? null,
    },
  });

  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true, electionId, slug: v.slug };
}

"use server";

import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { parseElectionForm, type ElectionFormResult } from "@/app/admin/elections/election-schema";

export async function createElection(
  _prev: ElectionFormResult | null,
  formData: FormData,
): Promise<ElectionFormResult> {
  await requireAdmin("/admin/elections/new");

  const parsed = parseElectionForm(formData);
  if (!parsed.ok) return parsed.result;
  const v = parsed.data;

  const existing = await prisma.election.findUnique({ where: { slug: v.slug }, select: { id: true } });
  if (existing) {
    return { ok: false, error: "這個 slug 已被使用", fieldErrors: { slug: "已被使用" } };
  }

  if (v.officeId) {
    const office = await prisma.office.findUnique({ where: { id: v.officeId }, select: { id: true } });
    if (!office) return { ok: false, error: "選定的對應職務不存在，請重新選擇" };
  }

  const created = await prisma.election.create({
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
      officeId: v.officeId ?? null,
      status: "draft",
    },
    select: { id: true, slug: true },
  });

  return { ok: true, electionId: created.id, slug: created.slug };
}

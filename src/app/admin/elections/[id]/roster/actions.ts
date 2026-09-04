"use server";
// 選舉人名冊匯入／移除。投票開始後（status ∈ voting 之後）只能新增，不能刪除既有條目，
// 避免有人投票後名冊被清掉導致對不上投票率／重複投票判斷。
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { LOCKED_STATUSES } from "@/lib/election-status";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RosterImportResult =
  | { ok: true; imported: number; skipped: number }
  | { ok: false; error: string };

export async function importRoster(electionId: string, raw: string): Promise<RosterImportResult> {
  await requireAdmin(`/admin/elections/${electionId}/roster`);

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, error: "請貼上至少一行" };

  const byEmail = new Map<string, { email: string; name: string | null }>();
  let invalid = 0;
  for (const line of lines) {
    const [emailRaw, ...rest] = line.split(",");
    const email = (emailRaw ?? "").trim().toLowerCase();
    const name = rest.join(",").trim() || null;
    if (!EMAIL_RE.test(email)) {
      invalid++;
      continue;
    }
    byEmail.set(email, { email, name }); // 同一批貼上內若重複 email，以後面那行為準
  }
  const rows = [...byEmail.values()];
  if (rows.length === 0) return { ok: false, error: "沒有格式正確的 email" };

  // 大量 upsert 一次塞進單一交易會撐爆預設 timeout；每 500 筆分一批、各批各自一個交易。
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await prisma.$transaction(
      batch.map((r) =>
        prisma.voter.upsert({
          where: { electionId_email: { electionId, email: r.email } },
          update: { name: r.name },
          create: { electionId, email: r.email, name: r.name },
        }),
      ),
      { timeout: 30_000 },
    );
  }

  revalidatePath(`/admin/elections/${electionId}/roster`);
  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true, imported: rows.length, skipped: invalid };
}

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function removeVoter(electionId: string, voterId: string): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}/roster`);

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (LOCKED_STATUSES.has(election.status)) {
    return { ok: false, error: "投票已開始，名冊只能新增，不能刪除" };
  }

  const voter = await prisma.voter.findUnique({ where: { id: voterId } });
  if (!voter || voter.electionId !== electionId) {
    return { ok: false, error: "找不到此名冊項目" };
  }

  await prisma.voter.delete({ where: { id: voterId } });

  revalidatePath(`/admin/elections/${electionId}/roster`);
  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true };
}

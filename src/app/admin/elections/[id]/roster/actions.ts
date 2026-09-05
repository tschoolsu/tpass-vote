"use server";
// 選舉人名冊匯入／移除。投票開始後（status ∈ voting 之後）只能新增，不能刪除既有條目，
// 避免有人投票後名冊被清掉導致對不上投票率／重複投票判斷。
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { LOCKED_STATUSES } from "@/lib/election-status";
import type { Prisma } from "@/generated/prisma/client";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RosterImportResult =
  | { ok: true; imported: number; skipped: number; skippedLines: { line: number; raw: string }[] }
  | { ok: false; error: string };

export async function importRoster(electionId: string, raw: string): Promise<RosterImportResult> {
  const admin = await requireAdmin(`/admin/elections/${electionId}/roster`);

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };

  // 用原始（含空行）分行結果編號，讓回報的「第 N 行」對得上使用者在 textarea 裡看到的行號。
  const rawLines = raw.split(/\r?\n/);
  if (rawLines.every((l) => l.trim() === "")) return { ok: false, error: "請貼上至少一行" };

  const byEmail = new Map<string, { email: string; name: string | null }>();
  const skippedLines: { line: number; raw: string }[] = [];
  rawLines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (line === "") return;
    const [emailRaw, ...rest] = line.split(",");
    const email = (emailRaw ?? "").trim().toLowerCase();
    const name = rest.join(",").trim() || null;
    if (!EMAIL_RE.test(email)) {
      skippedLines.push({ line: idx + 1, raw: line });
      return;
    }
    byEmail.set(email, { email, name }); // 同一批貼上內若重複 email，以後面那行為準
  });
  const invalid = skippedLines.length;
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

  // 匯入是分批多筆交易（見上），這裡的留痕是批次結束後的單一總結記錄，不追求與最後一批
  // 原子綁定——寫入失敗頂多少一筆稽核記錄，不影響名冊資料本身的正確性。
  await prisma.electionAuditLog.create({
    data: {
      electionId,
      actorEmail: admin.email,
      action: "import_roster",
      summary: `匯入名冊 ${rows.length} 筆（略過 ${invalid} 筆格式錯誤）`,
      diff: { imported: rows.length, skipped: invalid } as Prisma.InputJsonValue,
    },
  });

  revalidatePath(`/admin/elections/${electionId}/roster`);
  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true, imported: rows.length, skipped: invalid, skippedLines };
}

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function removeVoter(electionId: string, voterId: string): Promise<ActionResult> {
  const admin = await requireAdmin(`/admin/elections/${electionId}/roster`);

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (LOCKED_STATUSES.has(election.status)) {
    return { ok: false, error: "投票已開始，名冊只能新增，不能刪除" };
  }

  const voter = await prisma.voter.findUnique({ where: { id: voterId } });
  if (!voter || voter.electionId !== electionId) {
    return { ok: false, error: "找不到此名冊項目" };
  }

  await prisma.$transaction([
    prisma.voter.delete({ where: { id: voterId } }),
    prisma.electionAuditLog.create({
      data: {
        electionId,
        actorEmail: admin.email,
        action: "remove_voter",
        summary: `移除名冊項目：${voter.email}`,
        diff: { voterId: voter.id, email: voter.email } as Prisma.InputJsonValue,
      },
    }),
  ]);

  revalidatePath(`/admin/elections/${electionId}/roster`);
  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true };
}

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

  // 整次匯入（所有批次＋audit log）包在同一個交易裡：中途任何一批失敗就整筆回滾，
  // 不會留下半套名冊。名冊上限以 3000 列估算，分批只是避免單一 statement 過大，
  // 分批之間仍共用同一個 tx，30 秒 statement_timeout 內足夠。
  const BATCH_SIZE = 500;
  const result = await prisma.$transaction(async (tx) => {
    // 跟 removeVoter 同一個模式：交易外的一般 SELECT 讀到「未鎖定」後，advanceStatus
    // 能在檢查完、還沒寫之間插隊把投票開放，讓匯入把 rosterCount／投票率改掉。
    // 用 FOR SHARE 重讀最新 status——多個 importRoster/removeVoter 互不阻塞，只跟
    // 會改變 Election 狀態的那個 UPDATE（advanceStatus 隱含的 FOR NO KEY UPDATE）互斥。
    const [locked] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM "Election" WHERE id = ${electionId} FOR SHARE
    `;
    if (!locked) return { ok: false as const, error: "找不到選舉" };
    if (LOCKED_STATUSES.has(locked.status)) {
      return { ok: false as const, error: "投票開放後不能再匯入名冊" };
    }

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map((r) =>
          tx.voter.upsert({
            where: { electionId_email: { electionId, email: r.email } },
            update: { name: r.name },
            create: { electionId, email: r.email, name: r.name },
          }),
        ),
      );
    }

    await tx.electionAuditLog.create({
      data: {
        electionId,
        actorEmail: admin.email,
        action: "import_roster",
        summary: `匯入名冊 ${rows.length} 筆（略過 ${invalid} 筆格式錯誤）`,
        diff: { imported: rows.length, skipped: invalid } as Prisma.InputJsonValue,
      },
    });
    return { ok: true as const };
  }, { timeout: 30_000 });

  if (!result.ok) return result;

  revalidatePath(`/admin/elections/${electionId}/roster`);
  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true, imported: rows.length, skipped: invalid, skippedLines };
}

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function removeVoter(electionId: string, voterId: string): Promise<ActionResult> {
  const admin = await requireAdmin(`/admin/elections/${electionId}/roster`);

  const result = await prisma.$transaction(async (tx) => {
    // 交易外的一般 SELECT 讀到「未鎖定」後，advanceStatus 能在檢查完、還沒刪之間插隊
    // 把投票開放（D7-4）——這裡刪的是 Voter，不是 Election 本身，所以跟 castBallot 一樣
    // 用 FOR SHARE：多個 removeVoter 各刪不同人可以彼此並行，只需要跟「會改變 Election
    // 狀態」的那個 UPDATE（advanceStatus 隱含的 FOR NO KEY UPDATE）互斥。
    const [locked] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM "Election" WHERE id = ${electionId} FOR SHARE
    `;
    if (!locked) return { ok: false as const, error: "找不到選舉" };
    if (LOCKED_STATUSES.has(locked.status)) {
      return { ok: false as const, error: "投票已開始，名冊只能新增，不能刪除" };
    }

    const voter = await tx.voter.findUnique({ where: { id: voterId } });
    if (!voter || voter.electionId !== electionId) {
      return { ok: false as const, error: "找不到此名冊項目" };
    }

    await tx.voter.delete({ where: { id: voterId } });
    await tx.electionAuditLog.create({
      data: {
        electionId,
        actorEmail: admin.email,
        action: "remove_voter",
        summary: `移除名冊項目：${voter.email}`,
        diff: { voterId: voter.id, email: voter.email } as Prisma.InputJsonValue,
      },
    });
    return { ok: true as const };
  }, { timeout: 10_000 });

  if (!result.ok) return result;

  revalidatePath(`/admin/elections/${electionId}/roster`);
  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true };
}

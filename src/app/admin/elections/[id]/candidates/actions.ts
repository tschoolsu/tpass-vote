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

// 狀態檢查必須在「持鎖之後」重讀，且與後面的寫入同一個交易，否則 advanceStatus 能在
// 「檢查完、還沒寫」的窗口插隊 commit（D7-2）：改用 FOR NO KEY UPDATE 而不是
// vote/actions.ts castBallot 那種 FOR SHARE——因為 approve/reject/sendBack 三支都會在
// 同一交易內接著跑 renumberApproved，對整場候選人重新編號；若只用 FOR SHARE，兩個選委
// 同時審核不同候選人時會同時進入 renumberApproved 各自對 Candidate 表下鎖，彼此等待
// 造成死結（P2034/40P01）。FOR NO KEY UPDATE 自己跟自己互斥，讓兩個交易完全序列化：
// 後到的那個等前一個 commit 後才重讀狀態、往下走，兩邊都不會有機會同時碰
// renumberApproved，也就沒有死結可言——不需要升級到 FOR UPDATE。
// FOR UPDATE 是錯的：importRoster 對 3000 列 Voter 做 upsert，每一列的外鍵檢查都會對
// 父列 Election 取 FOR KEY SHARE 並持有整個交易（可長達 30 秒）；FOR KEY SHARE 只跟
// FOR UPDATE 衝突、跟 FOR NO KEY UPDATE 相容，選 FOR UPDATE 會讓這裡跟著卡到交易逾時
// 丟出未接住的例外（見 P7 反例，tests/integration/race.test.ts）。
async function lockElectionStatus(tx: Prisma.TransactionClient, electionId: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM "Election" WHERE id = ${electionId} FOR NO KEY UPDATE
  `;
  return row?.status ?? null;
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

  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.electionId !== electionId) return { ok: false, error: "找不到候選人" };

  const result = await prisma.$transaction(async (tx) => {
    const status = await lockElectionStatus(tx, electionId);
    if (status === null) return { ok: false as const, error: "找不到選舉" };
    if (LOCKED_STATUSES.has(status)) return { ok: false as const, error: "投票已開始，候選人名單已鎖定" };

    await tx.candidate.update({ where: { id: candidateId }, data: { status: "approved" } });
    await renumberApproved(tx, electionId);
    return { ok: true as const };
  }, { timeout: 10_000 });

  if (!result.ok) return result;
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

  const note = reviewNote.trim();
  if (note === "") return { ok: false, error: "退回補正需要填寫審核意見" };

  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.electionId !== electionId) return { ok: false, error: "找不到候選人" };

  const result = await prisma.$transaction(async (tx) => {
    const status = await lockElectionStatus(tx, electionId);
    if (status === null) return { ok: false as const, error: "找不到選舉" };
    if (LOCKED_STATUSES.has(status)) return { ok: false as const, error: "投票已開始，候選人名單已鎖定" };

    await tx.candidate.update({
      where: { id: candidateId },
      data: { status: "needs_fix", reviewNote: note },
    });
    await renumberApproved(tx, electionId);
    return { ok: true as const };
  }, { timeout: 10_000 });

  if (!result.ok) return result;
  revalidatePath(`/admin/elections/${electionId}/candidates`);
  return { ok: true };
}

export async function rejectCandidate(
  electionId: string,
  candidateId: string,
  reviewNote?: string,
): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}/candidates`);

  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.electionId !== electionId) return { ok: false, error: "找不到候選人" };

  const result = await prisma.$transaction(async (tx) => {
    const status = await lockElectionStatus(tx, electionId);
    if (status === null) return { ok: false as const, error: "找不到選舉" };
    if (LOCKED_STATUSES.has(status)) return { ok: false as const, error: "投票已開始，候選人名單已鎖定" };

    await tx.candidate.update({
      where: { id: candidateId },
      data: { status: "rejected", reviewNote: reviewNote?.trim() || null },
    });
    await renumberApproved(tx, electionId);
    return { ok: true as const };
  }, { timeout: 10_000 });

  if (!result.ok) return result;
  revalidatePath(`/admin/elections/${electionId}/candidates`);
  revalidatePath(`/admin/elections/${electionId}`);
  return { ok: true };
}

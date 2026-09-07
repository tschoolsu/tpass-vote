"use server";
// 罷免案（kind="recall"）管理端 server actions：成立、駁回、答辯書。
// 罷免案的「發起」已改為公開端（任一登入師生當領銜人），見 src/app/offices/[id]/recall/actions.ts。
// 罷免鏈：petition（連署中）→ established（已成立，等開票金鑰）→ voting → closed → sealed → published，
// established→voting 才複製選區名冊（§35，見 elections/[id]/actions.ts advanceStatus），
// voting 之後與一般選舉共用既有 sealElection / submitResults / 公告發布流程，不在這裡。
//
// 法源對應：
// - §28：會長副會長罷免案提出，應有當屆有效票總數 2/5 以上之連署（門檻＝src/lib/recall.ts，
//   母數＝罷免對象職務落地時的 Office.termValidCount 快照）。
// - §36：同意罷免票數多於不同意罷免票數者，通過。
import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { recallThreshold } from "@/lib/recall";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function establishRecall(id: string): Promise<ActionResult> {
  const admin = await requireAdmin(`/admin/elections/${id}`);

  const election = await prisma.election.findUnique({ where: { id } });
  if (!election) return { ok: false, error: "找不到罷免案" };
  if (election.status !== "petition") return { ok: false, error: "只有連署期間的罷免案才能推進到已成立" };
  if (!election.recallTargetOfficeId) return { ok: false, error: "罷免案缺少職務關聯，無法計算連署門檻" };

  const office = await prisma.office.findUnique({
    where: { id: election.recallTargetOfficeId },
    select: { termValidCount: true },
  });
  if (office?.termValidCount == null) {
    return { ok: false, error: "罷免對象職務無「當屆有效票」母數，無法計算連署門檻" };
  }
  const threshold = recallThreshold(office.termValidCount);

  const count = await prisma.recallSignature.count({ where: { electionId: id } });
  if (count < threshold) {
    return { ok: false, error: `連署數 ${count} 未達門檻 ${threshold}，無法成立罷免案` };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.election.updateMany({
      where: { id, status: "petition" }, // 樂觀鎖：防兩個選委同時推進
      data: { status: "established" },
    });
    if (result.count > 0) {
      await tx.electionAuditLog.create({
        data: {
          electionId: id,
          actorEmail: admin.email,
          action: "establish_recall",
          summary: `罷免案成立（連署 ${count} ／門檻 ${threshold}）`,
          diff: { signatureCount: count, threshold } as Prisma.InputJsonValue,
        },
      });
    }
    return result;
  });
  if (updated.count === 0) {
    return { ok: false, error: "狀態已被其他選委變更，請重新整理頁面" };
  }

  revalidatePath(`/admin/elections/${id}`);
  revalidatePath("/admin");
  return { ok: true };
}

// petition 期間駁回：軟刪除（hiddenAt），資料完全保留。reason 寫進 ElectionAuditLog.diff
// 供事後追查駁回理由（schema 沒有專屬欄位，稽核紀錄本身就是給這種用途用的）。
export async function rejectRecall(id: string, reason?: string): Promise<ActionResult> {
  const admin = await requireAdmin(`/admin/elections/${id}`);

  const election = await prisma.election.findUnique({ where: { id } });
  if (!election) return { ok: false, error: "找不到罷免案" };
  if (election.status !== "petition") return { ok: false, error: "只有連署期間的罷免案才能駁回" };
  if (election.hiddenAt) return { ok: false, error: "此罷免案已經是隱藏狀態" };

  const trimmedReason = reason?.trim() || null;

  await prisma.$transaction([
    prisma.election.update({ where: { id }, data: { hiddenAt: new Date() } }),
    prisma.electionAuditLog.create({
      data: {
        electionId: id,
        actorEmail: admin.email,
        action: "reject_recall",
        summary: trimmedReason ? `駁回罷免案，理由：${trimmedReason}` : "駁回罷免案",
        diff: { reason: trimmedReason } as Prisma.InputJsonValue,
      },
    }),
  ]);

  revalidatePath(`/admin/elections/${id}`);
  revalidatePath("/admin");
  return { ok: true };
}

export async function saveRecallDefense(id: string, text: string): Promise<ActionResult> {
  const admin = await requireAdmin(`/admin/elections/${id}`);

  const election = await prisma.election.findUnique({ where: { id } });
  if (!election) return { ok: false, error: "找不到罷免案" };
  if (election.status !== "established") {
    return { ok: false, error: "只有已成立的罷免案才能提交答辯書" };
  }

  await prisma.$transaction([
    prisma.election.update({ where: { id }, data: { recallDefense: text } }),
    prisma.electionAuditLog.create({
      data: {
        electionId: id,
        actorEmail: admin.email,
        action: "save_recall_defense",
        summary: "更新罷免答辯書",
        diff: { length: text.length } as Prisma.InputJsonValue,
      },
    }),
  ]);

  revalidatePath(`/admin/elections/${id}`);
  return { ok: true };
}

"use server";
// 三公告（first/second/result）草稿與發布。發布 result 公告時，若這是「第一次」發布，
// 需已有 resultsJson 且選舉狀態為 sealed，並在同一次交易內把選舉狀態從 sealed 推到 published；
// 之後再編輯已發布的公告內容，只更新文字，不重複觸發狀態轉換（否則會被鎖死）。
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";

export type ActionResult = { ok: true } | { ok: false; error: string };

const KINDS = ["first", "second", "result"] as const;
type Kind = (typeof KINDS)[number];

function validKind(k: string): k is Kind {
  return (KINDS as readonly string[]).includes(k);
}

export async function saveAnnouncementDraft(
  electionId: string,
  kind: string,
  title: string,
  body: string,
): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}/announcements`);
  if (!validKind(kind)) return { ok: false, error: "公告類型不正確" };
  const t = title.trim();
  if (t === "") return { ok: false, error: "請輸入標題" };

  const election = await prisma.election.findUnique({ where: { id: electionId }, select: { id: true } });
  if (!election) return { ok: false, error: "找不到選舉" };

  await prisma.announcement.upsert({
    where: { electionId_kind: { electionId, kind } },
    update: { title: t, body },
    create: { electionId, kind, title: t, body },
  });

  revalidatePath(`/admin/elections/${electionId}/announcements`);
  return { ok: true };
}

export async function publishAnnouncement(
  electionId: string,
  kind: string,
  title: string,
  body: string,
): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}/announcements`);
  if (!validKind(kind)) return { ok: false, error: "公告類型不正確" };
  const t = title.trim();
  if (t === "") return { ok: false, error: "請輸入標題" };

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };

  const existing = await prisma.announcement.findUnique({
    where: { electionId_kind: { electionId, kind } },
  });
  const isFirstPublish = !existing?.publishedAt;

  if (kind === "result" && isFirstPublish) {
    if (!election.resultsJson) return { ok: false, error: "尚未在開票頁提交計票結果，無法發布結果公告" };
    if (election.status !== "sealed") {
      return { ok: false, error: "只有已彌封且尚未公告的選舉能發布結果公告" };
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.announcement.upsert({
        where: { electionId_kind: { electionId, kind } },
        update: { title: t, body, publishedAt: existing?.publishedAt ?? new Date() },
        create: { electionId, kind, title: t, body, publishedAt: new Date() },
      });
      if (kind === "result" && isFirstPublish) {
        const bumped = await tx.election.updateMany({
          where: { id: electionId, status: "sealed" },
          data: { status: "published" },
        });
        if (bumped.count === 0) throw new Error("CONFLICT");
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message === "CONFLICT") {
      return { ok: false, error: "選舉狀態已被其他選委變更，請重新整理頁面" };
    }
    throw e;
  }

  revalidatePath(`/admin/elections/${electionId}/announcements`);
  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true };
}

"use server";
// 公告草稿與發布：自由公告流。legalTag 為 null 的一般公告可任意多則、無類型選擇，選委自由
// 發布任意數量；legalTag='result' 是唯一的法定特例，每場至多一則——這條「至多一則」不是 DB
// constraint，是這裡的 app 層規則：建立/改標籤時一律先查同場是否已有其他公告佔用 'result'，
// 衝突就直接擋掉並回錯誤，不會靜默覆寫別人的內容（步驟⑦結果公告面板據此保護唯一性）。
//
// 由 id 決定目標：id 給值＝更新既有那一則（可換 legalTag，但要過上面的佔用檢查）；
// id 為 null＝新建一則。回傳的 id 讓 client 端記住，之後儲存草稿變成「更新」而不是重複新建。
//
// 發布 result 公告：只有「這是 result 公告的第一次發布」且選舉狀態為 sealed 時，
// 在同一次交易內把選舉狀態從 sealed 推到 published；一般公告（legalTag=null）發布
// 絕不改變選舉狀態。已發布過的公告可以再編輯文字，但不會重複觸發狀態轉換。
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { upsertOfficesForElection } from "@/lib/office-upsert";
import type { TallyResult } from "@/lib/tally";

export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

const LEGAL_TAGS = ["result"] as const;
type LegalTag = (typeof LEGAL_TAGS)[number];

function validLegalTag(v: string): v is LegalTag {
  return (LEGAL_TAGS as readonly string[]).includes(v);
}

async function resolveTarget(
  electionId: string,
  id: string | null,
  legalTag: string | null,
): Promise<{ ok: true; existing: { id: string; publishedAt: Date | null } | null } | { ok: false; error: string }> {
  if (legalTag !== null && !validLegalTag(legalTag)) return { ok: false, error: "公告類型不正確" };

  if (id) {
    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (!existing || existing.electionId !== electionId) return { ok: false, error: "找不到此公告" };
    if (legalTag !== existing.legalTag && legalTag !== null) {
      const conflict = await prisma.announcement.findFirst({
        where: { electionId, legalTag, NOT: { id } },
      });
      if (conflict) return { ok: false, error: "這個公告類型已被其他公告佔用，請改為編輯既有那一則" };
    }
    return { ok: true, existing: { id: existing.id, publishedAt: existing.publishedAt } };
  }

  if (legalTag !== null) {
    const conflict = await prisma.announcement.findFirst({ where: { electionId, legalTag } });
    if (conflict) return { ok: false, error: "這個公告類型已被其他公告佔用，請改為編輯既有那一則" };
  }
  return { ok: true, existing: null };
}

export async function saveAnnouncementDraft(
  electionId: string,
  id: string | null,
  legalTag: string | null,
  title: string,
  body: string,
): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}`);
  const t = title.trim();
  if (t === "") return { ok: false, error: "請輸入標題" };

  const election = await prisma.election.findUnique({ where: { id: electionId }, select: { id: true } });
  if (!election) return { ok: false, error: "找不到選舉" };

  const target = await resolveTarget(electionId, id, legalTag);
  if (!target.ok) return target;

  const saved = target.existing
    ? await prisma.announcement.update({ where: { id: target.existing.id }, data: { title: t, body, legalTag } })
    : await prisma.announcement.create({ data: { electionId, legalTag, title: t, body } });

  revalidatePath(`/admin/elections/${electionId}`);
  return { ok: true, id: saved.id };
}

export async function publishAnnouncement(
  electionId: string,
  id: string | null,
  legalTag: string | null,
  title: string,
  body: string,
): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}`);
  const t = title.trim();
  if (t === "") return { ok: false, error: "請輸入標題" };

  const election = await prisma.election.findUnique({
    where: { id: electionId },
    include: { candidates: { where: { status: "approved" } } },
  });
  if (!election) return { ok: false, error: "找不到選舉" };

  const target = await resolveTarget(electionId, id, legalTag);
  if (!target.ok) return target;

  const isFirstPublish = !target.existing?.publishedAt;

  if (legalTag === "result" && isFirstPublish) {
    if (!election.resultsJson) return { ok: false, error: "尚未在開票頁提交計票結果，無法發布結果公告" };
    if (election.status !== "sealed") {
      return { ok: false, error: "只有已彌封且尚未公告的選舉能發布結果公告" };
    }
  }

  let savedId: string;
  try {
    savedId = await prisma.$transaction(async (tx) => {
      const saved = target.existing
        ? await tx.announcement.update({
            where: { id: target.existing!.id },
            data: { title: t, body, legalTag, publishedAt: target.existing!.publishedAt ?? new Date() },
          })
        : await tx.announcement.create({
            data: { electionId, legalTag, title: t, body, publishedAt: new Date() },
          });

      // sealed→published 觸發方式維持現況不動：發布 legalTag='result' 的公告時翻 published。
      if (legalTag === "result" && isFirstPublish) {
        const bumped = await tx.election.updateMany({
          where: { id: electionId, status: "sealed" },
          data: { status: "published" },
        });
        if (bumped.count === 0) throw new Error("CONFLICT");

        // 公告生效＝就職時刻：把當選人落地到職務登記表（genesis 建、連任/補選更新；
        // 罷免案通過則目標職務轉從缺）。resultsJson 前面已檢查存在。
        if (election.resultsJson) {
          await upsertOfficesForElection(
            tx,
            {
              id: election.id,
              kind: election.kind,
              title: election.title,
              officeId: election.officeId,
              recallTargetOfficeId: election.recallTargetOfficeId,
            },
            election.resultsJson as unknown as TallyResult,
            election.candidates,
          );
        }
      }
      return saved.id;
    }, { timeout: 10_000 });
  } catch (e) {
    if (e instanceof Error && e.message === "CONFLICT") {
      return { ok: false, error: "選舉狀態已被其他選委變更，請重新整理頁面" };
    }
    throw e;
  }

  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true, id: savedId };
}

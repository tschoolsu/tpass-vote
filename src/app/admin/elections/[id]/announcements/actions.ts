"use server";
// 公告草稿與發布：自由公告流。legalTag 為 null 的一般公告可任意多則、無類型選擇，選委自由
// 發布任意數量；legalTag='result' 是唯一的法定特例，每場至多一則——建立/改標籤時一律先查
// 同場是否已有其他公告佔用 'result'，衝突就直接擋掉並回錯誤，不會靜默覆寫別人的內容
// （步驟⑦結果公告面板據此保護唯一性）。這道 app 層檢查是先查後寫，兩個選委同時通過檢查
// 仍可能都走到 create——DB 端有 partial unique index 頂住最後一道防線（見 schema.prisma
// 的 Announcement model 註解），撞到時 create 會丟 P2002，下面 catch 住轉成友善錯誤。
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
import { Prisma } from "@/generated/prisma/client";

const RESULT_TAG_CONFLICT_ERROR = "這個公告類型已被其他公告佔用，請改為編輯既有那一則";

function isResultTagConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

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
      if (conflict) return { ok: false, error: RESULT_TAG_CONFLICT_ERROR };
    }
    return { ok: true, existing: { id: existing.id, publishedAt: existing.publishedAt } };
  }

  if (legalTag !== null) {
    const conflict = await prisma.announcement.findFirst({ where: { electionId, legalTag } });
    if (conflict) return { ok: false, error: RESULT_TAG_CONFLICT_ERROR };
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

  let saved: { id: string };
  try {
    saved = target.existing
      ? await prisma.announcement.update({ where: { id: target.existing.id }, data: { title: t, body, legalTag } })
      : await prisma.announcement.create({ data: { electionId, legalTag, title: t, body } });
  } catch (e) {
    if (isResultTagConflict(e)) return { ok: false, error: RESULT_TAG_CONFLICT_ERROR };
    throw e;
  }

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
  const admin = await requireAdmin(`/admin/elections/${electionId}`);
  const t = title.trim();
  if (t === "") return { ok: false, error: "請輸入標題" };

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (election.hiddenAt) return { ok: false, error: "這場選舉已作廢／隱藏，不能再操作" };

  const target = await resolveTarget(electionId, id, legalTag);
  if (!target.ok) return target;

  const isFirstPublish = !target.existing?.publishedAt;

  // 快速失敗：交易外先擋一次，訊息具體、也省一次交易——但這只是 UX 提示，
  // 不是最終防線。真正說了算的是下面交易內鎖到 Election 之後重讀的那份。
  if (legalTag === "result" && isFirstPublish) {
    if (!election.resultsJson) return { ok: false, error: "尚未在開票頁提交計票結果，無法發布結果公告" };
    if (election.status !== "sealed") {
      return { ok: false, error: "只有已彌封且尚未公告的選舉能發布結果公告" };
    }
  }

  // 只有「結果公告的第一次發布」需要鎖 Election 那一列（要保護 sealed→published
  // 這個狀態轉換、且要讓 Office 落地讀到鎖定後的最新 resultsJson）。一般公告
  // （legalTag=null）貫穿投票全程都能發、從不動 Election，若也跟著取
  // FOR NO KEY UPDATE，會被 importRoster／removeVoter／castBallot 對 Election
  // 取的 FOR SHARE 卡住——一次合法的大量名冊匯入就能把選委的公告發布卡到逾時。
  const isResultPublish = legalTag === "result" && isFirstPublish;

  let savedId: string;
  try {
    savedId = await prisma.$transaction(async (tx) => {
      // 與 submitResults 同一把鎖、同一順序：先鎖 Election 再動 Announcement——兩邊
      // 順序一致才不會在高併發時互等對方持有的鎖造成死結（40P01）。resultsJson／
      // status／hiddenAt 在這裡鎖定後一次讀齊；鎖沒放手之前這一列不會再變，所以
      // 底下所有判斷與 upsertOfficesForElection 一律用這份 locked，不用交易外
      // 那份可能已經過期的快照（submitResults 若在窗口內插隊 commit 新結果，
      // 舊快照落地的就會是舊的當選人）。
      let locked: { status: string; hiddenAt: Date | null; resultsJson: unknown } | undefined;
      if (isResultPublish) {
        [locked] = await tx.$queryRaw<
          { status: string; hiddenAt: Date | null; resultsJson: unknown }[]
        >`SELECT status, "hiddenAt", "resultsJson" FROM "Election" WHERE id = ${electionId} FOR NO KEY UPDATE`;
        if (!locked) throw new Error("CONFLICT");
      }

      const saved = target.existing
        ? await tx.announcement.update({
            where: { id: target.existing!.id },
            data: { title: t, body, legalTag, publishedAt: target.existing!.publishedAt ?? new Date() },
          })
        : await tx.announcement.create({
            data: { electionId, legalTag, title: t, body, publishedAt: new Date() },
          });

      // sealed→published 觸發方式維持現況不動：發布 legalTag='result' 的公告時翻 published。
      if (isResultPublish) {
        // hiddenAt／status／resultsJson 都用鎖定後讀到的 locked，不用交易外那份：
        // 擋掉「交易外檢查完、hideElection 或 submitResults 才插隊 commit」的窗口。
        if (locked!.hiddenAt || locked!.status !== "sealed" || !locked!.resultsJson) {
          throw new Error("CONFLICT");
        }

        const bumped = await tx.election.updateMany({
          where: { id: electionId, status: "sealed", hiddenAt: null },
          data: { status: "published" },
        });
        if (bumped.count === 0) throw new Error("CONFLICT");

        // 公告生效＝就職時刻：把當選人落地到職務登記表（genesis 建、連任/補選更新；
        // 罷免案通過則目標職務轉從缺）。candidates 也在交易內查，同一份鎖之下讀。
        const candidates = await tx.candidate.findMany({
          where: { electionId, status: "approved" },
        });
        await upsertOfficesForElection(
          tx,
          {
            id: election.id,
            kind: election.kind,
            title: election.title,
            officeId: election.officeId,
            recallTargetOfficeId: election.recallTargetOfficeId,
          },
          locked!.resultsJson as unknown as TallyResult,
          candidates,
        );
      }

      await tx.electionAuditLog.create({
        data: {
          electionId,
          actorEmail: admin.email,
          action: "publish_announcement",
          summary: isResultPublish
            ? `發布結果公告「${t}」，選舉狀態轉為 published`
            : `發布公告「${t}」`,
          diff: { announcementId: saved.id, legalTag, isFirstPublish } as Prisma.InputJsonValue,
        },
      });

      return saved.id;
    }, { timeout: 10_000 });
  } catch (e) {
    if (e instanceof Error && e.message === "CONFLICT") {
      return { ok: false, error: "選舉狀態已被其他選委變更，請重新整理頁面" };
    }
    if (isResultTagConflict(e)) return { ok: false, error: RESULT_TAG_CONFLICT_ERROR };
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      (e.code === "P2034" || e.code === "P2028")
    ) {
      return { ok: false, error: "有人同時在操作這場選舉，請重新整理後再試" };
    }
    throw e;
  }

  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true, id: savedId };
}

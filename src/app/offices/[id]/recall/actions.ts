"use server";
// 公開發起罷免（領銜人模式）：任一登入師生可對某職務發起罷免案。
// 建立一個 kind="recall" / status="petition" 的罷免案，記領銜人，並自動算領銜人為第一筆連署。
// 之後其他人到 /e/[slug] 連署（全校開放），達 2/5 由選委在工作台按「成立」。
//
// 安全不變量：身分一律取自 session（requireSession），不信任 client 傳來的身分。
// 硬條件（§27 就職滿 2 個月、職務未從缺、無進行中連署案）在交易內二次驗證，不倚賴畫面。
import { Prisma } from "@/generated/prisma/client";
import { requireSession } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { canInitiateRecall } from "@/lib/recall";

export type InitiateRecallResult =
  | { ok: true; slug: string }
  | { ok: false; error: string; existingSlug?: string };

export async function initiateRecall(officeId: string, reason: string): Promise<InitiateRecallResult> {
  const session = await requireSession(`/offices/${officeId}/recall/new`);

  const trimmedReason = reason.trim();
  if (trimmedReason === "") return { ok: false, error: "請填寫罷免事由" };

  try {
    const created = await prisma.$transaction(async (tx) => {
      const office = await tx.office.findUnique({ where: { id: officeId } });
      if (!office) throw new InitiateError("找不到此職務");
      if (office.isVacant) throw new InitiateError("此職務目前從缺，無法發起罷免");
      if (!canInitiateRecall(office.startedAt, new Date())) {
        throw new InitiateError("此職務就職未滿 2 個月，依規定尚不得提起罷免");
      }

      const existing = await tx.election.findFirst({
        where: { recallTargetOfficeId: officeId, kind: "recall", status: "petition", hiddenAt: null },
        select: { slug: true },
      });
      if (existing) throw new InitiateError("此職務已有進行中的罷免連署", existing.slug);

      // slug：以 officeId 為穩定 base（使用者從 /offices 連過去，不需可讀 slug），撞名遞增。
      let slug = `recall-${office.id}`;
      let n = 2;
      while (await tx.election.findUnique({ where: { slug }, select: { id: true } })) {
        slug = `recall-${office.id}-${n}`;
        n++;
      }

      const election = await tx.election.create({
        data: {
          slug,
          title: `${office.title}罷免案`,
          kind: "recall",
          status: "petition",
          ballotMode: "approval",
          seats: 1,
          maxChoices: 1,
          recallReason: trimmedReason,
          recallTargetOfficeId: office.id,
          recallLeadEmail: session.email,
          recallLeadName: session.name ?? null,
          parentId: office.sourceElectionId, // 供 UI 顯示「原選舉」連結，非強制
        },
      });

      // 罷免用候選人（組）＝計票對象，沿用既有 submitResults/公告草稿以 Candidate 為單位的邏輯。
      const candidate = await tx.candidate.create({
        data: {
          electionId: election.id,
          members: office.currentMembers as Prisma.InputJsonValue,
          number: 1,
          platform: "",
          status: "approved",
          createdBy: session.email,
        },
      });
      await tx.election.update({
        where: { id: election.id },
        data: { recallTargetCandidateId: candidate.id },
      });

      // 領銜人自動算第一筆連署。
      await tx.recallSignature.create({
        data: { electionId: election.id, signerEmail: session.email },
      });

      await tx.electionAuditLog.create({
        data: {
          electionId: election.id,
          actorEmail: session.email,
          action: "initiate_recall",
          summary: `發起罷免（領銜人：${session.email}）`,
          diff: { officeId: office.id, leadEmail: session.email } as Prisma.InputJsonValue,
        },
      });

      return election;
    }, { timeout: 10_000 });

    return { ok: true, slug: created.slug };
  } catch (e) {
    if (e instanceof InitiateError) {
      return { ok: false, error: e.message, existingSlug: e.existingSlug };
    }
    throw e;
  }
}

class InitiateError extends Error {
  existingSlug?: string;
  constructor(message: string, existingSlug?: string) {
    super(message);
    this.name = "InitiateError";
    this.existingSlug = existingSlug;
  }
}

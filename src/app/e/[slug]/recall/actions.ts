"use server";
// 罷免連署公開端 server actions。安全不變量：
// 1. 身分一律取自 session（requireSession），不信任 client 傳來的任何身分。
// 2. 具名連署，一人一署：靠 RecallSignature 的 @@unique([electionId, signerEmail]) 擋重複。
// 3. 連署資格＝全校任一登入師生（不限選區，產品決策）——故不查 Voter 名冊；petition 階段
//    本就沒有名冊。§35 的「投票限原選區」在 established→voting 推進時才複製名冊、另行把關。
//    門檻母數＝罷免對象職務落地時的 Office.termValidCount 快照（§28）。

import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { recallThreshold } from "@/lib/recall";

export type SignResult =
  | { ok: true; count: number; threshold: number }
  | { ok: false; error: string };

async function loadRecallThreshold(recallTargetOfficeId: string | null): Promise<number> {
  if (!recallTargetOfficeId) return 0;
  const office = await prisma.office.findUnique({
    where: { id: recallTargetOfficeId },
    select: { termValidCount: true },
  });
  if (office?.termValidCount == null) return 0;
  return recallThreshold(office.termValidCount);
}

export async function signRecall(slug: string): Promise<SignResult> {
  const session = await requireSession(`/e/${slug}/recall`);

  const election = await prisma.election.findFirst({ where: { slug, hiddenAt: null } });
  if (!election) return { ok: false, error: "找不到這場罷免案" };
  if (election.kind !== "recall") return { ok: false, error: "這不是罷免案" };
  if (election.status !== "petition") return { ok: false, error: "目前非連署期間" };

  try {
    await prisma.recallSignature.create({
      data: { electionId: election.id, signerEmail: session.email },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "你已經連署過了" };
    }
    throw e;
  }

  const count = await prisma.recallSignature.count({ where: { electionId: election.id } });
  const threshold = await loadRecallThreshold(election.recallTargetOfficeId);
  return { ok: true, count, threshold };
}

export async function withdrawSignature(slug: string): Promise<SignResult> {
  const session = await requireSession(`/e/${slug}/recall`);

  const election = await prisma.election.findFirst({ where: { slug, hiddenAt: null } });
  if (!election) return { ok: false, error: "找不到這場罷免案" };
  if (election.kind !== "recall") return { ok: false, error: "這不是罷免案" };
  if (election.status !== "petition") return { ok: false, error: "目前非連署期間，無法撤回" };

  const deleted = await prisma.recallSignature.deleteMany({
    where: { electionId: election.id, signerEmail: session.email },
  });
  if (deleted.count === 0) return { ok: false, error: "你尚未連署，無需撤回" };

  const count = await prisma.recallSignature.count({ where: { electionId: election.id } });
  const threshold = await loadRecallThreshold(election.recallTargetOfficeId);
  return { ok: true, count, threshold };
}

"use server";
// 罷免連署公開端 server actions。安全不變量：
// 1. 身分一律取自 session（requireSession），不信任 client 傳來的任何身分。
// 2. 具名連署，一人一署：靠 RecallSignature 的 @@unique([electionId, signerEmail]) 擋重複。
// 3. 連署資格＝原選區名冊——建罷免案當下已把原選舉名冊複製進這場的 Voter 表，
//    這裡只要查這場自己的 Voter 即可，不必回頭查 parent。

import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { recallThreshold } from "@/lib/recall";
import type { TallyResult } from "@/lib/tally";

export type SignResult =
  | { ok: true; count: number; threshold: number }
  | { ok: false; error: string };

async function loadRecallThreshold(parentId: string | null): Promise<number> {
  if (!parentId) return 0;
  const parent = await prisma.election.findUnique({
    where: { id: parentId },
    select: { resultsJson: true },
  });
  if (!parent?.resultsJson) return 0;
  const results = parent.resultsJson as unknown as TallyResult;
  return recallThreshold(results.validCount);
}

export async function signRecall(slug: string): Promise<SignResult> {
  const session = await requireSession(`/e/${slug}/recall`);

  const election = await prisma.election.findFirst({ where: { slug, hiddenAt: null } });
  if (!election) return { ok: false, error: "找不到這場罷免案" };
  if (election.kind !== "recall") return { ok: false, error: "這不是罷免案" };
  if (election.status !== "petition") return { ok: false, error: "目前非連署期間" };

  const voter = await prisma.voter.findUnique({
    where: { electionId_email: { electionId: election.id, email: session.email } },
  });
  if (!voter) return { ok: false, error: "你不具本案連署資格（不在原選區名冊內）" };

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
  const threshold = await loadRecallThreshold(election.parentId);
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
  const threshold = await loadRecallThreshold(election.parentId);
  return { ok: true, count, threshold };
}

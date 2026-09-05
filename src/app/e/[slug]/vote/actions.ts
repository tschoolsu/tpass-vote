"use server";
// 投票 server action。安全不變量：
// 1. 身分一律取自 session（requireSession），不信任 client 傳來的任何身分。
// 2. 伺服器只收「密文」，永遠看不到選擇內容；只做形狀 sanity check。
// 3. 一人一格：EncryptedBallot 以 voterId upsert——截止前重投＝覆寫，以最後一次為準。

import { requireSession } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { castDecision, CAST_REJECTION_MESSAGES } from "@/lib/vote-policy";
import { isValidCiphertextShape, receiptOf } from "@/lib/ballot-crypto";

export type CastResult =
  | { ok: true; receipt: string; revote: boolean }
  | { ok: false; error: string };

export async function castBallot(slug: string, ciphertext: string): Promise<CastResult> {
  const session = await requireSession(`/e/${slug}/vote`);

  const election = await prisma.election.findFirst({ where: { slug, hiddenAt: null } });
  if (!election) return { ok: false, error: "找不到這場選舉" };

  const voter = await prisma.voter.findUnique({
    where: { electionId_email: { electionId: election.id, email: session.email.trim().toLowerCase() } },
  });

  const decision = castDecision(election, voter !== null, new Date());
  if (!decision.ok) return { ok: false, error: CAST_REJECTION_MESSAGES[decision.reason] };

  if (!isValidCiphertextShape(ciphertext)) {
    return { ok: false, error: "選票格式不正確，請重新整理頁面再試" };
  }

  const now = new Date();
  const revote = voter!.votedAt !== null;
  await prisma.$transaction([
    prisma.encryptedBallot.upsert({
      where: { voterId: voter!.id },
      create: { electionId: election.id, voterId: voter!.id, ciphertext },
      update: { ciphertext },
    }),
    prisma.voter.update({ where: { id: voter!.id }, data: { votedAt: now } }),
  ]);

  return { ok: true, receipt: await receiptOf(ciphertext), revote };
}

"use server";
// 投票 server action。安全不變量：
// 1. 身分一律取自 session（requireSession），不信任 client 傳來的任何身分。
// 2. 伺服器只收「密文」，永遠看不到選擇內容；只做形狀 sanity check。
// 3. 一人一格：EncryptedBallot 以 voterId upsert——截止前重投＝覆寫，以最後一次為準。

import { requireSession } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { castDecision, CAST_REJECTION_MESSAGES, type CastRejection } from "@/lib/vote-policy";
import { isValidCiphertextShape } from "@/lib/ballot-crypto";

// 沒有 receipt：可回溯代碼由投票人瀏覽器產生並封在密文裡，伺服器看不到它。
// 代碼由前端在送出成功後自己顯示（見 VoteForm）。
export type CastResult = { ok: true; revote: boolean } | { ok: false; error: string };

/** 鎖內判定失敗：靠 throw 讓交易回滾，不能只 return——否則後面的寫入會照跑。 */
class CastRejected extends Error {
  constructor(readonly reason: CastRejection) {
    super(reason);
  }
}

type CastGate = {
  status: string;
  votingStartsAt: Date | null;
  votingEndsAt: Date | null;
};

export async function castBallot(slug: string, ciphertext: string): Promise<CastResult> {
  const session = await requireSession(`/e/${slug}/vote`);

  const election = await prisma.election.findFirst({ where: { slug, hiddenAt: null } });
  if (!election) return { ok: false, error: "找不到這場選舉" };

  const voter = await prisma.voter.findUnique({
    where: { electionId_email: { electionId: election.id, email: session.email.trim().toLowerCase() } },
  });

  // 交易外先擋一次：名冊外、時程未到這類註定失敗的請求不必進去排隊搶鎖。
  const pre = castDecision(election, voter !== null, new Date());
  if (!pre.ok) return { ok: false, error: CAST_REJECTION_MESSAGES[pre.reason] };

  if (!isValidCiphertextShape(ciphertext)) {
    return { ok: false, error: "選票格式不正確，請重新整理頁面再試" };
  }

  const revote = voter!.votedAt !== null;
  try {
    await prisma.$transaction(async (tx) => {
      // 關票（advanceStatus）的 UPDATE 隱含取 FOR NO KEY UPDATE，彌封
      // （sealElection）顯式取 FOR UPDATE。這裡取 FOR SHARE 與兩者都互斥，
      // 但收票彼此之間相容——用 FOR UPDATE 會把所有收票序列化，大規模投票會塞死。
      //
      // 一般 SELECT 不鎖列：Postgres 預設 READ COMMITTED 下，光把查詢搬進
      // $transaction 擋不住關票插隊，必須顯式取鎖後「在鎖裡」重新判定一次。
      const [locked] = await tx.$queryRaw<CastGate[]>`
        SELECT status, "votingStartsAt", "votingEndsAt"
        FROM "Election" WHERE id = ${election.id} FOR SHARE
      `;
      if (!locked) throw new CastRejected("not-open");
      // 名冊在投票期間只能新增不能刪除（removeVoter 的 LOCKED_STATUSES 擋著），
      // 所以交易外確認過的資格在這裡仍然成立。
      const decision = castDecision(locked, true, new Date());
      if (!decision.ok) throw new CastRejected(decision.reason);

      await tx.encryptedBallot.upsert({
        where: { voterId: voter!.id },
        create: { electionId: election.id, voterId: voter!.id, ciphertext },
        update: { ciphertext },
      });
      await tx.voter.update({ where: { id: voter!.id }, data: { votedAt: new Date() } });
    }, { timeout: 10_000 });
  } catch (e) {
    if (e instanceof CastRejected) {
      return { ok: false, error: CAST_REJECTION_MESSAGES[e.reason] };
    }
    throw e;
  }

  return { ok: true, revote };
}

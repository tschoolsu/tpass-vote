"use server";
// 投票 server action。安全不變量：
// 1. 身分一律取自 session（requireSession），不信任 client 傳來的任何身分。
// 2. 伺服器只收「密文」，永遠看不到選擇內容；只做形狀 sanity check。
// 3. 一人一票，送出後不能改：EncryptedBallot 沒有 voterId，一人一格改由 Voter.hasVoted
//    的鎖內判定達成。§26-1 Ⅳ 不得記錄代碼與個別選舉人之連結——票匭列在投票期間就
//    不該有任何指得回人的欄位，不是等到彌封才處理。
// 4. 收票交易會額外「擾動」K 列不相干的資料，理由見 PERTURB_K。

import { requireSession } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import {
  castDecision,
  CAST_REJECTION_MESSAGES,
  PERTURB_K,
  type CastRejection,
} from "@/lib/vote-policy";
import { canonicalizeCiphertext } from "@/lib/ballot-crypto";

// 沒有 receipt：可回溯代碼由投票人瀏覽器產生並封在密文裡，伺服器看不到它。
// 代碼由前端在進入確認頁時就顯示（見 VoteForm）。
export type CastResult = { ok: true } | { ok: false; error: string };

/** 鎖內判定失敗：靠 throw 讓交易回滾，不能只 return——否則後面的寫入會照跑。 */
class CastRejected extends Error {
  constructor(readonly reason: CastRejection | "hidden") {
    super(reason);
  }
}

type CastGate = {
  status: string;
  votingStartsAt: Date | null;
  votingEndsAt: Date | null;
  hiddenAt: Date | null;
};

export async function castBallot(slug: string, ciphertext: string): Promise<CastResult> {
  const session = await requireSession(`/e/${slug}/vote`);

  // 明確 select：不撈 sealedBox——投票中的選舉票匭快照根本不存在，撈整列只是白白
  // 把其他大欄位（resultsJson／disclosuresJson）一起帶進來，投票是全校最熱的請求路徑。
  const election = await prisma.election.findFirst({
    where: { slug, hiddenAt: null },
    select: { id: true, status: true, votingStartsAt: true, votingEndsAt: true },
  });
  if (!election) return { ok: false, error: "找不到這場選舉" };

  const voter = await prisma.voter.findUnique({
    where: { electionId_email: { electionId: election.id, email: session.email } },
  });

  // 交易外先擋一次：名冊外、時程未到這類註定失敗的請求不必進去排隊搶鎖。
  const pre = castDecision(election, voter !== null, new Date());
  if (!pre.ok) return { ok: false, error: CAST_REJECTION_MESSAGES[pre.reason] };
  // 已經投過的人同理，而且更要擋在外面：不擋的話「同一人狂點送出」會讓每個請求都進交易、
  // 在同一列上排隊，各佔一條連線（pool max=10）直到前面的人 commit。
  // 這只是快速路徑，有 TOCTOU 窗口，真正的判定在鎖內。
  if (voter!.hasVoted) return { ok: false, error: CAST_REJECTION_MESSAGES["already-voted"] };

  // 存進 DB／公開 sealedBox 的一律是這裡重建出來的正規字串，不是 client 送來的
  // 原始位元組——不然投票端能靠合法但重新排版過的 JSON（多餘空白、重複 key、
  // 欄位順序）自由控制那段公開字串的內容與長度，形狀檢查形同虛設。
  const canonical = canonicalizeCiphertext(ciphertext);
  if (canonical === null) {
    return { ok: false, error: "選票格式不正確，請重新整理頁面再試" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 關票（advanceStatus）的 UPDATE 隱含取 FOR NO KEY UPDATE，彌封
      // （sealElection）顯式取 FOR UPDATE。這裡取 FOR SHARE 與兩者都互斥，
      // 但收票彼此之間相容——用 FOR UPDATE 會把所有收票序列化，大規模投票會塞死。
      //
      // 一般 SELECT 不鎖列：Postgres 預設 READ COMMITTED 下，光把查詢搬進
      // $transaction 擋不住關票插隊，必須顯式取鎖後「在鎖裡」重新判定一次。
      const [locked] = await tx.$queryRaw<CastGate[]>`
        SELECT status, "votingStartsAt", "votingEndsAt", "hiddenAt"
        FROM "Election" WHERE id = ${election.id} FOR SHARE
      `;
      if (!locked) throw new CastRejected("not-open");
      // 交易外的 findFirst 只擋得住「進交易前」就已隱藏的場次；隱藏發生在
      // 交易外檢查之後、鎖內重讀之前的窗口，得在這裡再擋一次。
      if (locked.hiddenAt) throw new CastRejected("hidden");
      // 名冊在投票期間只能新增不能刪除（removeVoter 的 LOCKED_STATUSES 擋著），
      // 所以交易外確認過的資格在這裡仍然成立。
      const decision = castDecision(locked, true, new Date());
      if (!decision.ok) throw new CastRejected(decision.reason);

      // 抽 K 個擾動對象。名冊 ≤3000 列，ORDER BY random() 的成本可以忽略；
      // 換成更聰明的抽樣只會讓這段更難讀。
      const others = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Voter"
        WHERE "electionId" = ${election.id} AND id <> ${voter!.id}
        ORDER BY random() LIMIT ${PERTURB_K}
      `;
      const voterIds = [voter!.id, ...others.map((o) => o.id)].sort();

      // 自己這列與擾動列一次鎖完，而且**依 id 升冪**。全站每個收票交易都用同一個順序
      // 取 Voter 列鎖，才不會兩個交易各握著對方要的列互等。ORDER BY 會讓 LockRows
      // 節點排在 Sort 之上，所以真的是照排序後的順序上鎖。
      //
      // 鎖到手之後這個交易不會再要求任何新的 Voter 列鎖，也不會回頭升級鎖強度——
      // 改動前的 ballot.upsert（對 Voter 取 FOR KEY SHARE）→ voter.update（升級成
      // FOR NO KEY UPDATE）才是經典的死鎖形狀，這次順便拆掉了。
      const claimRows = await tx.$queryRaw<{ id: string; hasVoted: boolean }[]>`
        SELECT id, "hasVoted" FROM "Voter"
        WHERE id IN (${Prisma.join(voterIds)}) ORDER BY id FOR UPDATE
      `;
      const self = claimRows.find((r) => r.id === voter!.id);
      if (!self) throw new CastRejected("not-in-roster");
      // 鎖在手上，這個值不會再變——這就是「一人一票」的權威判定。voterId 的 unique
      // index 被拿掉之後，DB 層已經沒有別的東西擋得住重複投票，只剩這一句。
      if (self.hasVoted) throw new CastRejected("already-voted");

      // 認領與擾動一起做：自己那列翻成 true，其他列值不變但一樣被改寫，
      // 於是本交易的 xid 同時出現在 K+1 個人身上。這些列剛剛都鎖過了，不會再有死鎖風險。
      await tx.$executeRaw`
        UPDATE "Voter" SET "hasVoted" = ("hasVoted" OR id = ${voter!.id})
        WHERE id IN (${Prisma.join(voterIds)})
      `;

      // 票匭擾動：同樣抽 K 張、依 id 升冪上鎖後原值改寫。票數還不到 K 張時自然只擾動
      // 得到現有的幾張——最早投的那幾個人匿名集比較小，這跟已知的小票匭問題
      //（tests/audit 的 D3-2／D3-4）同源，不另外處理。
      const otherBallots = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "EncryptedBallot"
        WHERE "electionId" = ${election.id}
        ORDER BY random() LIMIT ${PERTURB_K}
      `;
      if (otherBallots.length > 0) {
        const ballotIds = otherBallots.map((b) => b.id);
        await tx.$executeRaw`
          UPDATE "EncryptedBallot" SET ciphertext = ciphertext
          WHERE id IN (
            SELECT id FROM "EncryptedBallot"
            WHERE id IN (${Prisma.join(ballotIds)}) ORDER BY id FOR UPDATE
          )
        `;
      }

      // 自己這張票。沒有 voterId、沒有時間戳、id 是隨機 UUID——插進去之後跟票匭裡
      // 其他票長得一模一樣，只剩 xmin 可能洩漏，而那個已經被上面的擾動稀釋掉了。
      await tx.encryptedBallot.create({
        data: { electionId: election.id, ciphertext: canonical },
      });
    }, { timeout: 10_000 });
  } catch (e) {
    if (e instanceof CastRejected) {
      // "hidden" 與交易外 findFirst 找不到選舉時的訊息一致，不查
      // CAST_REJECTION_MESSAGES——那張表只覆蓋 castDecision 的判定結果。
      if (e.reason === "hidden") return { ok: false, error: "找不到這場選舉" };
      return { ok: false, error: CAST_REJECTION_MESSAGES[e.reason] };
    }
    throw e;
  }

  return { ok: true };
}

// 2026-09-08「拿掉重投、票匭不含身分」這批改動的迴歸測試。
//
// 這裡守的四件事，任何一件破掉都是法規問題（§26-1 Ⅳ）或會讓整場選舉開不了票：
//   1. 票匭列不含任何指得回選舉人的欄位，也不含任何可排序的時間線索。
//   2. xmin 的 K-匿名擾動真的有發生——這是 schema 改動單獨做不到的那一半。
//   3. 一人一票：併發送出恰好成功一次（DB 層的 unique 約束已隨 voterId 一起消失）。
//   4. 「張數 == 已投票人數」的不變量：不成立就拒絕彌封；有票的場次不准還原。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { ADMIN, as } from "../helpers/session";
import {
  advanceTo,
  approveAll,
  ciphertextFor,
  generateKeys,
  importVoters,
  makeElection,
  registerAs,
  voteAs,
} from "../helpers/flow";
import { castBallot } from "@/app/e/[slug]/vote/actions";
import { sealElection } from "@/app/admin/elections/[id]/tally/actions";
import { hideElection, restoreElection } from "@/app/admin/elections/[id]/actions";
import { PERTURB_K } from "@/lib/vote-policy";
import type { TestIdentity } from "../helpers/jwks";

const CAND: TestIdentity = { email: "unlink-cand@test.local", name: "候選人" };
// 名冊要比 K 大一截：不只是為了讓擾動抽得滿 K 個對象，也因為 K/N 太大時後面的票會把
// 前面的 xid 幾乎洗光，剩下的群組會小到失去代表性（K=16、N=24 時最小匿名集會掉到 1）。
// 取 4K 讓比例接近真實選舉（全校 800 人、K=16）。
const ROSTER = PERTURB_K * 4;
const voters: TestIdentity[] = Array.from({ length: ROSTER }, (_, i) => ({
  email: `unlink-v${i}@test.local`,
  name: `選舉人${i}`,
}));

async function setupVotingElection(slug: string) {
  const created = await makeElection({ slug, seats: 1, maxChoices: 1 });
  if (!created.ok) throw new Error(created.error);
  const electionId = created.electionId!;
  const { publicKeyJwk } = await generateKeys(electionId, slug);
  await importVoters(electionId, [...voters, CAND]);
  await advanceTo(electionId, "registration");
  await registerAs(slug, electionId, CAND);
  const [cand] = await approveAll(electionId);
  await advanceTo(electionId, "voting");
  return { electionId, publicKeyJwk, candidateId: cand.id };
}

describe("票匭不含身分，且 xmin 被擾動成 K-匿名", () => {
  const slug = "unlinkable";
  let electionId: string;
  let publicKeyJwk: JsonWebKey;
  let candidateId: string;
  /** 最後一位投票人那個交易的 xid，靠他剛插進去的那張票讀出來。 */
  let lastXid: string;

  beforeAll(async () => {
    await resetDb();
    ({ electionId, publicKeyJwk, candidateId } = await setupVotingElection(slug));

    // 先讓票匭長到遠超過 K 張，最後一位才抽得滿 K 張票來擾動。
    for (const v of voters) {
      const r = await voteAs(slug, electionId, v, publicKeyJwk, {
        type: "choose",
        candidateIds: [candidateId],
      });
      expect(r.ok, `${v.email} 投票失敗`).toBe(true);
    }

    const measured = await voteAs(slug, electionId, CAND, publicKeyJwk, {
      type: "choose",
      candidateIds: [candidateId],
    });
    expect(measured.ok).toBe(true);
    const [row] = await prisma.$queryRaw<{ xid: string }[]>`
      SELECT xmin::text AS xid FROM "EncryptedBallot"
      WHERE "electionId" = ${electionId} AND ciphertext = ${measured.ciphertext}
    `;
    lastXid = row.xid;
  }, 120_000);

  it("票匭列只有 id／electionId／ciphertext，沒有身分也沒有時間", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'EncryptedBallot' ORDER BY column_name
    `;
    // 加回 voterId／email 是違法（AGENTS.md 紅線）；加回 createdAt／updatedAt 則是把
    // 投票順序用另一種形式寫回去，一樣要擋。
    expect(cols.map((c) => c.column_name)).toEqual(["ciphertext", "electionId", "id"]);
  });

  it("票匭 id 是隨機 UUID，不是可排序的 cuid／uuid v7", async () => {
    const ids = (
      await prisma.encryptedBallot.findMany({ where: { electionId }, select: { id: true } })
    ).map((b) => b.id);
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const id of ids) expect(id, `${id} 不是 UUIDv4`).toMatch(uuidV4);
    // 排序過的 id 順序若等於插入順序，等於把投票順序寫進主鍵。UUIDv4 是隨機的，
    // 這裡不直接比順序（隨機也可能碰巧遞增），改用版本位元判定，那是決定性的。
  });

  it("收票交易的 xid 落在 K+1 個選舉人與 K+1 張票上（xmin 不是唯一指紋）", async () => {
    const [{ n: voterRows }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Voter"
      WHERE "electionId" = ${electionId} AND xmin::text = ${lastXid}
    `;
    const [{ n: ballotRows }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "EncryptedBallot"
      WHERE "electionId" = ${electionId} AND xmin::text = ${lastXid}
    `;
    // 自己那列 + K 個被原值改寫的擾動列。等於 1 就代表擾動沒發生：
    // 那時一句 JOIN ON b.xmin = v.xmin 就能精確還原誰投哪張。
    expect(voterRows, "xid 只落在一位選舉人身上＝Voter 側沒有被擾動").toBe(PERTURB_K + 1);
    expect(ballotRows, "xid 只落在一張票上＝票匭側沒有被擾動").toBe(PERTURB_K + 1);
  });

  // 擾動是**稀釋**不是消滅：後來的票會覆蓋前面留下的 xid，侵蝕到最後約 1.5% 的選舉人
  // 會剩下「這個 xid 只對到你一個人、也只對到一張票」，那一票就被精確還原了（比例與名冊
  // 大小無關）。所以這裡只記錄侵蝕程度、不斷言為零——真正把這條通道歸零的是關票時的
  // 塌縮（見下一個 describe），那才是決定性的防線。
  it("投票進行中：xmin 通道被稀釋，但還沒歸零（記錄侵蝕程度）", async () => {
    // xid 型別沒有 hash/sort 的 operator class，直接 GROUP BY xmin 會 "could not
    // implement GROUP BY"——先在子查詢裡轉成 text 再分組。
    const rows = await prisma.$queryRaw<{ xid: string; voters: number; ballots: number }[]>`
      SELECT xid, count(DISTINCT voter_id)::int AS voters, count(DISTINCT ballot_id)::int AS ballots
      FROM (
        SELECT b.xmin::text AS xid, v.id AS voter_id, b.id AS ballot_id
        FROM "EncryptedBallot" b
        JOIN "Voter" v ON b.xmin = v.xmin AND v."electionId" = ${electionId}
        WHERE b."electionId" = ${electionId}
      ) j
      GROUP BY xid
    `;
    // 某個 xid 只對到一位選舉人、且只對到一張票 ⇒ 那一對被精確還原。
    const pinned = rows.filter((r) => r.voters === 1 && r.ballots === 1).length;
    const ratio = pinned / ROSTER;
    console.log(
      `  ▸ xid 群組 ${rows.length} 組・被精確還原 ${pinned}/${ROSTER} 人（${(ratio * 100).toFixed(1)}%）`,
    );
    // 上限抓 10%，遠高於模擬的 ~1.5%，所以不會間歇性紅；但擾動整個失效時（每個 xid 各自
    // 只對到一個人一張票）會是 100%，這條就擋得住。真正的斷言是上面那條 K+1。
    expect(ratio, "xmin 擾動幾乎沒有作用——收票交易可能沒有真的改寫其他列").toBeLessThan(0.1);
  });
});

describe("關票會把整場的 xmin 塌縮，投票期間殘留的線索一次歸零", () => {
  const slug = "unlinkable-collapse";
  let electionId: string;

  beforeAll(async () => {
    await resetDb();
    const setup = await setupVotingElection(slug);
    electionId = setup.electionId;
    for (const v of voters) {
      const r = await voteAs(slug, electionId, v, setup.publicKeyJwk, {
        type: "choose",
        candidateIds: [setup.candidateId],
      });
      expect(r.ok, `${v.email} 投票失敗`).toBe(true);
    }
    await advanceTo(electionId, "closed");
  }, 180_000);

  it("關票後全場只剩一個 xid，join 出來是 N×N 的組合＝零資訊", async () => {
    const distinct = async (table: "Voter" | "EncryptedBallot") => {
      const rows =
        table === "Voter"
          ? await prisma.$queryRaw<{ xid: string }[]>`
              SELECT DISTINCT xmin::text AS xid FROM "Voter" WHERE "electionId" = ${electionId}`
          : await prisma.$queryRaw<{ xid: string }[]>`
              SELECT DISTINCT xmin::text AS xid FROM "EncryptedBallot" WHERE "electionId" = ${electionId}`;
      return rows.map((r) => r.xid);
    };
    const voterXids = await distinct("Voter");
    const ballotXids = await distinct("EncryptedBallot");

    expect(voterXids, "名冊的 xmin 沒有被塌縮成同一個交易").toHaveLength(1);
    expect(ballotXids, "票匭的 xmin 沒有被塌縮成同一個交易").toHaveLength(1);
    expect(voterXids[0], "名冊與票匭不是同一個交易寫的，兩邊仍分得出先後").toBe(ballotXids[0]);

    // 於是這句 join 對每個人都吐出整個票匭，一個人都定不下來。
    const [{ n: pinned }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT v.id FROM "Voter" v
        JOIN "EncryptedBallot" b ON b.xmin = v.xmin AND b."electionId" = ${electionId}
        WHERE v."electionId" = ${electionId}
        GROUP BY v.id HAVING count(*) = 1
      ) t
    `;
    expect(pinned, "還有人的票能被 xmin join 精確還原").toBe(0);
  });
});

describe("一人一票（DB 層的 unique 約束已隨 voterId 一起消失）", () => {
  it("同一人併發送出 30 張，恰好一張入匭", async () => {
    await resetDb();
    const slug = "unlinkable-once";
    const { electionId, publicKeyJwk, candidateId } = await setupVotingElection(slug);

    const payloads = await Promise.all(
      Array.from({ length: 30 }, () =>
        ciphertextFor(publicKeyJwk, electionId, { type: "choose", candidateIds: [candidateId] }),
      ),
    );
    const results = await Promise.all(
      payloads.map((ct) => as(voters[0], () => castBallot(slug, ct))),
    );

    const okCount = results.filter((r) => r.ok).length;
    expect(okCount, "併發送出的成功次數不是恰好一次").toBe(1);
    for (const r of results) {
      if (!r.ok) expect(r.error).toMatch(/只能投一次/);
    }
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(1);
    expect(await prisma.voter.count({ where: { electionId, hasVoted: true } })).toBe(1);
  }, 120_000);
});

describe("張數 == 已投票人數 的不變量", () => {
  it("票匭多出一張對不到人的票時，彌封被擋下", async () => {
    await resetDb();
    const slug = "unlinkable-seal";
    const { electionId, publicKeyJwk, candidateId } = await setupVotingElection(slug);

    for (const v of voters.slice(0, 6)) {
      const r = await voteAs(slug, electionId, v, publicKeyJwk, {
        type: "choose",
        candidateIds: [candidateId],
      });
      expect(r.ok).toBe(true);
    }

    // 孤兒票：只插票、不動名冊。正常路徑不可能產生（castBallot 兩個寫入同進同出），
    // 但 voterId 的 FK cascade 沒了之後，任何「刪掉已投票的人」的新路徑都會製造出來。
    await prisma.encryptedBallot.create({
      data: {
        electionId,
        ciphertext: await ciphertextFor(publicKeyJwk, electionId, { type: "blank" }),
      },
    });

    await advanceTo(electionId, "closed");
    const sealed = await as(ADMIN, () => sealElection(electionId, true));
    expect(sealed.ok, "張數對不上還是讓它彌封了——公告出去的投票率會是錯的").toBe(false);
    if (!sealed.ok && "error" in sealed) expect(sealed.error).toMatch(/張數/);

    // 拒絕要是乾淨的：票匭沒被刪、狀態沒被推進。
    const e = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(e.status).toBe("closed");
    expect(e.sealedBox).toBeNull();
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(7);
  }, 120_000);
});

describe("有票的場次隱藏後不准還原", () => {
  it("restoreElection 擋下來，並告訴選委改走重辦", async () => {
    await resetDb();
    const slug = "unlinkable-restore";
    const { electionId, publicKeyJwk, candidateId } = await setupVotingElection(slug);

    const r = await voteAs(slug, electionId, voters[0], publicKeyJwk, {
      type: "choose",
      candidateIds: [candidateId],
    });
    expect(r.ok).toBe(true);

    // hideElection 會 redirect("/admin")，那是以 throw 的形式離開的，不是失敗。
    await as(ADMIN, () => hideElection(electionId, "測試：作廢")).catch(() => {});
    const hidden = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(hidden.hiddenAt, "沒有真的被隱藏，後面測不到東西").not.toBeNull();
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(0);

    const restored = await as(ADMIN, () => restoreElection(electionId));
    expect(restored.ok, "還原出來會是「0 張票 + 投不了票的人」，不該放行").toBe(false);
    if (!restored.ok) expect(restored.error).toMatch(/重辦/);

    // 真的沒有被還原。
    const after = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(after.hiddenAt).not.toBeNull();
  }, 120_000);
});

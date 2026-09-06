// 收票 × 關票 × 彌封的競態。這三者共用一個真相：Election 那一列。
//
// 測法：另開一條 pg 連線，在交易裡先鎖住 Election 那一列，把待測動作卡在鎖上，
// 在鎖住的窗口內做出「會出事的那件事」，再放行。這樣競態是確定性的，不靠碰運氣。
//
// 鎖層級的選擇很重要：
// - FOR UPDATE 會連 EncryptedBallot 的 INSERT 都擋住（外鍵要對父列取 FOR KEY SHARE），
//   彌封那個案例會直接死結。
// - FOR NO KEY UPDATE 擋得住 Election 的 UPDATE，卻放行子表 INSERT——正是我們要的窗口。
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "pg";
import { prisma, resetDb, TEST_DATABASE_URL } from "../helpers/db";
import { ADMIN, VOTER_A, VOTER_B, as } from "../helpers/session";
import {
  advanceTo,
  approveAll,
  generateKeys,
  importVoters,
  makeElection,
  registerAs,
} from "../helpers/flow";
import { encryptBallot } from "@/lib/ballot-crypto";
import { castBallot } from "@/app/e/[slug]/vote/actions";
import { sealElection } from "@/app/admin/elections/[id]/tally/actions";

const CAND = { email: "racecand@test.local", name: "候選人" };
const SLUG = "race";

/** 開一條獨立連線並鎖住某場選舉，回傳「放行」函式。 */
async function holdElectionLock(electionId: string, mode: "no key update" | "update") {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");
  await client.query(`SELECT id FROM "Election" WHERE id = $1 FOR ${mode}`, [electionId]);
  return {
    client,
    async release(sql?: { text: string; values: unknown[] }) {
      if (sql) await client.query(sql.text, sql.values);
      await client.query("COMMIT");
      await client.end();
    },
    async abort() {
      await client.query("ROLLBACK").catch(() => {});
      await client.end().catch(() => {});
    },
  };
}

/** 讓卡在鎖上的那個動作真的走到取鎖那一步。 */
const settle = () => new Promise((r) => setTimeout(r, 500));

describe("收票與關票／彌封的競態", () => {
  let electionId: string;
  let publicKeyJwk: JsonWebKey;
  let candidateId: string;

  beforeEach(async () => {
    await resetDb();
    const created = await makeElection({ slug: SLUG });
    electionId = created.electionId!;
    const keys = await generateKeys(electionId, SLUG);
    publicKeyJwk = keys.publicKeyJwk;
    await importVoters(electionId, [VOTER_A, VOTER_B, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(SLUG, electionId, CAND);
    const [cand] = await approveAll(electionId);
    candidateId = cand.id;
    await advanceTo(electionId, "voting");
  }, 60_000);

  it("關票已經發生但尚未 commit 時送出的票，不會在關票之後才被收下", async () => {
    const lock = await holdElectionLock(electionId, "no key update");
    try {
      // 鎖窗內把狀態改成 closed（尚未 commit——不取鎖的讀取只會看到舊的 voting）。
      await lock.client.query(`UPDATE "Election" SET status = 'closed' WHERE id = $1`, [
        electionId,
      ]);

      const { ciphertext } = await encryptBallot(publicKeyJwk, {
        electionId,
        choice: { type: "choose", candidateIds: [candidateId] },
      });
      const voting = as(VOTER_A, () => castBallot(SLUG, ciphertext));
      await settle();
      await lock.release();

      const r = await voting;
      expect(r.ok, "關票 commit 之後這張票仍被收下了").toBe(false);
      expect(
        await prisma.encryptedBallot.count({ where: { electionId } }),
        "票匭裡出現了關票之後才寫入的票",
      ).toBe(0);
    } catch (e) {
      await lock.abort();
      throw e;
    }
  }, 60_000);

  it("彌封期間才落地的票，不會被刪掉卻沒進票匭", async () => {
    // 先正常收一張票，再關票。
    const { ciphertext: early } = await encryptBallot(publicKeyJwk, {
      electionId,
      choice: { type: "choose", candidateIds: [candidateId] },
    });
    expect((await as(VOTER_A, () => castBallot(SLUG, early))).ok).toBe(true);
    await advanceTo(electionId, "closed");

    const voterB = await prisma.voter.findUniqueOrThrow({
      where: { electionId_email: { electionId, email: VOTER_B.email } },
    });
    const { ciphertext: late } = await encryptBallot(publicKeyJwk, {
      electionId,
      choice: { type: "choose", candidateIds: [candidateId] },
    });

    const lock = await holdElectionLock(electionId, "no key update");
    try {
      const sealing = as(ADMIN, () => sealElection(electionId));
      await settle();

      // 一個停滯的收票交易此刻才落地。走 raw create 是刻意的：這裡測的是彌封自己
      // 有沒有把「讀票匭」放進同一個交易，與 castBallot 有沒有取鎖是兩件獨立的事。
      await prisma.encryptedBallot.create({
        data: { electionId, voterId: voterB.id, ciphertext: late },
      });

      await lock.release();
      const sealed = await sealing;
      expect(sealed.ok, sealed.ok ? "" : sealed.error).toBe(true);

      const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
      const box = election.sealedBox as string[];
      expect(box, "彌封期間落地的票被 deleteMany 刪掉，卻不在票匭快照裡").toContain(late);
      expect(box).toContain(early);
      expect(box.length).toBe(2);
      expect(
        await prisma.encryptedBallot.count({ where: { electionId } }),
        "彌封後還留著身分↔選票的對應",
      ).toBe(0);
    } catch (e) {
      await lock.abort();
      throw e;
    }
  }, 60_000);

  it("D7-8：收票交易途中被隱藏，票必須被拒且不落地", async () => {
    const lock = await holdElectionLock(electionId, "no key update");
    try {
      // 鎖窗內把 hiddenAt 寫掉（尚未 commit）：castBallot 交易外的 findFirst
      // 讀到舊值（未隱藏）→ 通過；交易內重讀 status/時程時應一併讀到這個新值。
      await lock.client.query(`UPDATE "Election" SET "hiddenAt" = now() WHERE id = $1`, [
        electionId,
      ]);

      const { ciphertext } = await encryptBallot(publicKeyJwk, {
        electionId,
        choice: { type: "choose", candidateIds: [candidateId] },
      });
      const voting = as(VOTER_A, () => castBallot(SLUG, ciphertext));
      await settle();
      await lock.release();

      const r = await voting;
      expect(r.ok, "選舉被隱藏之後這張票仍被收下了").toBe(false);
      expect(
        await prisma.encryptedBallot.count({ where: { electionId } }),
        "票匭裡出現了隱藏之後才寫入的票",
      ).toBe(0);
    } catch (e) {
      await lock.abort();
      throw e;
    }
  }, 60_000);
});

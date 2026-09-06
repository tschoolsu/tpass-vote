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
import { ADMIN, MODERATOR, VOTER_A, VOTER_B, as } from "../helpers/session";
import {
  advanceTo,
  approveAll,
  generateKeys,
  importVoters,
  makeElection,
  registerAs,
  seal,
  tallyAndSubmit,
  toLocalInput,
  voteAs,
  HOUR,
} from "../helpers/flow";
import { encryptBallot, generateTallyKeyPair } from "@/lib/ballot-crypto";
import { castBallot } from "@/app/e/[slug]/vote/actions";
import { sealElection, submitResults } from "@/app/admin/elections/[id]/tally/actions";
import { approveCandidate, rejectCandidate } from "@/app/admin/elections/[id]/candidates/actions";
import { updateElection } from "@/app/admin/elections/[id]/edit/actions";
import { removeVoter } from "@/app/admin/elections/[id]/roster/actions";
import { sealElection } from "@/app/admin/elections/[id]/tally/actions";
import { savePublicKey } from "@/app/admin/elections/[id]/actions";

const CAND = { email: "racecand@test.local", name: "候選人" };
const SLUG = "race";

/** 開一條獨立連線並鎖住某場選舉，回傳「放行」函式。 */
async function holdElectionLock(electionId: string, mode: "key share" | "no key update" | "update") {
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
      // confirmSmallBox: true——這裡測的是彌封交易本身的鎖，不是 D3-2 的小票匭確認，
      // 帶 true 跳過票數前置檢查，才會真的進到下面的鎖等待。
      const sealing = as(ADMIN, () => sealElection(electionId, true));
      await settle();

      // 一個停滯的收票交易此刻才落地。走 raw create 是刻意的：這裡測的是彌封自己
      // 有沒有把「讀票匭」放進同一個交易，與 castBallot 有沒有取鎖是兩件獨立的事。
      await prisma.encryptedBallot.create({
        data: { electionId, voterId: voterB.id, ciphertext: late },
      });

      await lock.release();
      const sealed = await sealing;
      expect(sealed.ok, sealed.ok || !("error" in sealed) ? "" : sealed.error).toBe(true);

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

// D7-2／D7-3／D7-4／D7-5（搬自 tests/audit/D7-races.test.ts）：四支 admin action 的狀態檢查
// 曾經在交易外，advanceStatus／publishAnnouncement 能在「檢查完、還沒寫」的窗口插隊 commit，
// 讓已經讀到舊狀態的 action 照樣把寫入落地。手法統一用 holdElectionLock("no key update")
// 卡住 action 交易內的鎖讀取，在鎖窗內直接用另一條連線把狀態改掉（尚未 commit，模擬另一位
// 選委的動作正要 commit），放行後斷言 action 讀到的是「鎖釋放當下的最新狀態」。
const CAND_A = { email: "d7cand-a@test.local", name: "候選人甲" };
const CAND_B = { email: "d7cand-b@test.local", name: "候選人乙" };

describe("D7-2 候選人審核：狀態檢查與寫入不再跨交易", () => {
  const SLUG = "d7-cand";
  let electionId: string;
  let candA: string;
  let candB: string;

  beforeEach(async () => {
    await resetDb();
    const created = await makeElection({ slug: SLUG });
    electionId = created.electionId!;
    await generateKeys(electionId, SLUG);
    await importVoters(electionId, [VOTER_A, VOTER_B, CAND_A, CAND_B]);
    await advanceTo(electionId, "registration");
    await registerAs(SLUG, electionId, CAND_A);
    await registerAs(SLUG, electionId, CAND_B);
    const approved = await approveAll(electionId);
    candA = approved[0].id;
    candB = approved[1].id;
    await advanceTo(electionId, "campaigning");
  }, 90_000);

  it("投票開放的狀態改動一旦 commit，卡住的 rejectCandidate 必須讀到新狀態並被擋下", async () => {
    const lock = await holdElectionLock(electionId, "no key update");
    try {
      // 鎖窗內把狀態改成 voting（尚未 commit，模擬 advanceStatus 正要 commit）。
      await lock.client.query(`UPDATE "Election" SET status = 'voting' WHERE id = $1`, [
        electionId,
      ]);

      const rejecting = as(ADMIN, () => rejectCandidate(electionId, candB, "臨時退選"));
      await settle();
      await lock.release();
      const rejected = await rejecting;

      expect(rejected.ok, "投票已開放，退回動作本應被 LOCKED_STATUSES 擋下").toBe(false);

      const b = await prisma.candidate.findUniqueOrThrow({ where: { id: candB } });
      const a = await prisma.candidate.findUniqueOrThrow({ where: { id: candA } });
      expect(b.status, "候選人狀態不該被改動").toBe("approved");
      expect(b.number, "號次不該被抽掉").not.toBeNull();
      expect(a.number, "另一位候選人的號次不該被重排").toBe(1);
    } catch (e) {
      await lock.abort();
      throw e;
    }
  }, 60_000);

  it("P7：importRoster 的 Voter upsert 對 Election 取的 FOR KEY SHARE，不該卡住 approveCandidate", async () => {
    // importRoster 對 3000 列 Voter 做 upsert，每一列的外鍵檢查都會對父列 Election
    // 取 FOR KEY SHARE 並持有整個交易（可長達 30 秒）。approveCandidate 只需要跟
    // 其他會改 Election 這一列本身的動作互斥（FOR NO KEY UPDATE 對 FOR NO KEY UPDATE），
    // 不該因為選了過強的鎖模式（FOR UPDATE）而被無關的子表 INSERT 卡住。
    const fkLock = await holdElectionLock(electionId, "key share");
    let settled = false;
    const approving = as(ADMIN, () => approveCandidate(electionId, candB)).then((r) => {
      settled = true;
      return r;
    });
    try {
      await settle();
      // 先斷言、再釋放鎖：卡住的話這裡會是 false，且下面 release 之後才會變 true——
      // 用時序本身當證據，不是等它最終成功就當作沒事。
      expect(
        settled,
        "approveCandidate 被無關的 FOR KEY SHARE 卡住了，鎖模式選得比需要的強",
      ).toBe(true);
      await fkLock.release();
      const approved = await approving;
      expect(approved.ok, approved.ok ? "" : approved.error).toBe(true);
    } catch (e) {
      await fkLock.abort();
      await approving.catch(() => {});
      throw e;
    }
  }, 60_000);

  it("兩位選委同時核准兩位不同候選人：不再死結，兩邊都成功且號次不衝突", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await prisma.candidate.updateMany({
        where: { electionId },
        data: { status: "pending", number: null },
      });
      const results = await Promise.allSettled([
        as(ADMIN, () => approveCandidate(electionId, candA)),
        as(MODERATOR, () => approveCandidate(electionId, candB)),
      ]);
      for (const r of results) {
        expect(r.status, `第 ${attempt} 次同時核准出現未處理例外`).toBe("fulfilled");
        if (r.status === "fulfilled") {
          expect(r.value.ok, r.value.ok ? "" : r.value.error).toBe(true);
        }
      }
      const numbers = (
        await prisma.candidate.findMany({
          where: { electionId, status: "approved" },
          select: { number: true },
        })
      ).map((c) => c.number);
      expect(new Set(numbers).size, "兩位候選人的號次撞號").toBe(2);
      expect(numbers.every((n) => n !== null), "有候選人沒被編號").toBe(true);
    }
  }, 120_000);
});

describe("D7-3 updateElection：狀態檢查與寫入不再跨交易", () => {
  const SLUG = "d7-edit";
  let electionId: string;

  beforeEach(async () => {
    await resetDb();
    const created = await makeElection({ slug: SLUG });
    electionId = created.electionId!;
    await generateKeys(electionId, SLUG);
    await importVoters(electionId, [VOTER_A, CAND_A]);
    await advanceTo(electionId, "registration");
    await registerAs(SLUG, electionId, CAND_A);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");
  }, 90_000);

  it("P7：slug 沒有變動時，importRoster 的 FOR KEY SHARE 不該卡住 updateElection", async () => {
    // 這裡刻意送出跟現有 slug 相同的值：這是 updateElection 真正的常見路徑（表單預填
    // 原 slug、選委沒去動它），此時 Prisma 的 UPDATE 不需要碰 slug 這個唯一鍵欄位，
    // 停在 FOR NO KEY UPDATE 就夠，跟 FOR KEY SHARE 相容、不會被 importRoster 卡住。
    // 反例（slug 真的變動時仍會卡住）見下一個測試——那不是鎖模式選錯，見
    // edit/actions.ts 交易內的註解。
    const fkLock = await holdElectionLock(electionId, "key share");
    let settled = false;
    const form = new FormData();
    form.set("title", "改個標題");
    form.set("slug", SLUG);
    form.set("kind", "other");
    form.set("seats", "1");
    form.set("maxChoices", "1");
    const editing = as(MODERATOR, () => updateElection(electionId, null, form)).then((r) => {
      settled = true;
      return r;
    });
    try {
      await settle();
      expect(
        settled,
        "updateElection 被無關的 FOR KEY SHARE 卡住了，鎖模式選得比需要的強",
      ).toBe(true);
      await fkLock.release();
      const edited = await editing;
      expect(edited.ok, edited.ok ? "" : edited.error).toBe(true);
    } catch (e) {
      await fkLock.abort();
      await editing.catch(() => {});
      throw e;
    }
  }, 60_000);

  it("P7 反例：slug 真的變動時，updateElection 仍會被 FOR KEY SHARE 卡住——這是 Postgres 對唯一鍵欄位的鎖升級，不是鎖模式選錯", async () => {
    // Postgres 的 heap_update 只要偵測到會寫入的欄位是唯一鍵（slug 是 @unique）且新值
    // 真的不同，就會把這一列的 tuple lock 升級成排他等級，這發生在實際執行 UPDATE 的
    // 那一刻，跟交易一開始用 SELECT ... FOR NO KEY UPDATE 或 FOR UPDATE 重讀狀態
    // 無關——換成 FOR UPDATE 一樣救不了，因為衝突點在後面的 UPDATE 本身，不在前面
    // 的 SELECT。所以這裡卡住是正確、預期的行為：等 importRoster 放手後，
    // updateElection 照樣正確完成，不是死結、也沒有資料損毀。
    const fkLock = await holdElectionLock(electionId, "key share");
    let settled = false;
    const form = new FormData();
    form.set("title", "改個標題");
    form.set("slug", "d7-edit-p7-changed");
    form.set("kind", "other");
    form.set("seats", "1");
    form.set("maxChoices", "1");
    const editing = as(MODERATOR, () => updateElection(electionId, null, form)).then((r) => {
      settled = true;
      return r;
    });
    try {
      await settle();
      expect(settled, "slug 真的變動時，這裡應該被 FOR KEY SHARE 卡住").toBe(false);
      await fkLock.release();
      const edited = await editing;
      expect(edited.ok, edited.ok ? "" : edited.error).toBe(true);
    } catch (e) {
      await fkLock.abort();
      await editing.catch(() => {});
      throw e;
    }
  }, 60_000);

  it("投票開放一旦 commit，卡住的 updateElection 必須讀到新狀態並被擋下", async () => {
    const lock = await holdElectionLock(electionId, "no key update");
    try {
      await lock.client.query(`UPDATE "Election" SET status = 'voting' WHERE id = $1`, [
        electionId,
      ]);

      const start = new Date(Date.now() - 100 * HOUR);
      const end = new Date(Date.now() - HOUR);
      const form = new FormData();
      form.set("title", "被改掉的選舉");
      form.set("slug", "d7-edit-changed");
      form.set("kind", "other");
      form.set("seats", "7");
      form.set("maxChoices", "7");
      form.set("votingStartsAt", toLocalInput(start));
      form.set("votingEndsAt", toLocalInput(end));
      const editing = as(MODERATOR, () => updateElection(electionId, null, form));
      await settle();
      await lock.release();
      const edited = await editing;

      expect(edited.ok, "投票已開放，編輯本應被 LOCKED_STATUSES 擋下").toBe(false);

      const e = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
      expect(e.status).toBe("voting");
      expect(e.slug, "公開連結不該被換掉").toBe(SLUG);
      expect(e.seats, "名額不該在投票期間被改").not.toBe(7);
      expect(
        e.votingEndsAt === null || e.votingEndsAt.getTime() >= Date.now() - HOUR,
        "投票截止時間不該被改成過去",
      ).toBe(true);
    } catch (e) {
      await lock.abort();
      throw e;
    }
  }, 60_000);
});

describe("D7-4 removeVoter：狀態檢查與寫入不再跨交易", () => {
  const SLUG = "d7-roster";
  let electionId: string;

  beforeEach(async () => {
    await resetDb();
    const created = await makeElection({ slug: SLUG });
    electionId = created.electionId!;
    await generateKeys(electionId, SLUG);
    await importVoters(electionId, [VOTER_A, VOTER_B, CAND_A]);
    await advanceTo(electionId, "registration");
    await registerAs(SLUG, electionId, CAND_A);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");
  }, 90_000);

  it("投票開放一旦 commit，卡住的 removeVoter 必須讀到新狀態並被擋下，票不會被靜默 cascade 刪掉", async () => {
    const voter = await prisma.voter.findUniqueOrThrow({
      where: { electionId_email: { electionId, email: VOTER_A.email } },
    });

    const lock = await holdElectionLock(electionId, "no key update");
    try {
      await lock.client.query(`UPDATE "Election" SET status = 'voting' WHERE id = $1`, [
        electionId,
      ]);

      const removing = as(ADMIN, () => removeVoter(electionId, voter.id));
      await settle();
      await lock.release();
      const removed = await removing;

      expect(removed.ok, "投票已開放，名冊刪除本應被擋下").toBe(false);
      expect(
        await prisma.voter.count({ where: { id: voter.id } }),
        "投票人不該被從名冊移除",
      ).toBe(1);
    } catch (e) {
      await lock.abort();
      throw e;
    }
  }, 60_000);
});

describe("D7-5 submitResults：狀態檢查與寫入不再跨交易", () => {
  const SLUG = "d7-publish";
  let electionId: string;

  beforeEach(async () => {
    await resetDb();
    const created = await makeElection({ slug: SLUG });
    electionId = created.electionId!;
    const { publicKeyJwk, keyFiles } = await generateKeys(electionId, SLUG);
    await importVoters(electionId, [VOTER_A, VOTER_B, CAND_A, CAND_B]);
    await advanceTo(electionId, "registration");
    await registerAs(SLUG, electionId, CAND_A);
    await registerAs(SLUG, electionId, CAND_B);
    const approved = await approveAll(electionId);
    await advanceTo(electionId, "voting");
    await voteAs(SLUG, electionId, VOTER_A, publicKeyJwk, {
      type: "choose",
      candidateIds: [approved[0].id],
    });
    await voteAs(SLUG, electionId, VOTER_B, publicKeyJwk, {
      type: "choose",
      candidateIds: [approved[0].id],
    });
    await advanceTo(electionId, "closed");
    await seal(electionId);
    const t = await tallyAndSubmit(electionId, SLUG, keyFiles);
    expect(t.submitted.ok, "首次提交結果應成功").toBe(true);
  }, 120_000);

  it("公告一旦把狀態 commit 成 published，卡住的重新提交必須讀到新狀態並被擋下，結果不被覆寫", async () => {
    const before = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    const results = JSON.parse(JSON.stringify(before.resultsJson)) as {
      candidates: { candidateId: string; elected: boolean }[];
    };
    const disclosures = JSON.parse(JSON.stringify(before.disclosuresJson));
    // 只翻當選旗標：verifyDisclosures 不驗 elected，所以形狀檢查照樣過。
    for (const c of results.candidates) c.elected = !c.elected;

    const lock = await holdElectionLock(electionId, "no key update");
    try {
      // 模擬 publishAnnouncement 正要把 sealed → published commit 掉。
      await lock.client.query(`UPDATE "Election" SET status = 'published' WHERE id = $1`, [
        electionId,
      ]);

      const submitting = as(MODERATOR, () => submitResults(electionId, results, disclosures));
      await settle();
      await lock.release();
      const sub = await submitting;

      expect(sub.ok, "已公告的選舉不該再接受結果提交").toBe(false);

      const after = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
      expect(after.status).toBe("published");
      const stored = after.resultsJson as unknown as {
        candidates: { candidateId: string; elected: boolean }[];
      };
      const flipped = stored.candidates.map((c) => c.elected);
      const original = (
        before.resultsJson as unknown as { candidates: { elected: boolean }[] }
      ).candidates.map((c) => c.elected);
      expect(flipped, "公告之後結果不該被改寫").toEqual(original);
    } catch (e) {
      await lock.abort();
      throw e;
    }
  }, 60_000);
});

describe("D7-1：savePublicKey 兩位選委同時產鑰的競態", () => {
  it("兩把公鑰幾乎同時送存，只能有一次成功，DB 不會被後寫者悄悄覆蓋", async () => {
    await resetDb();
    const created = await makeElection({ slug: "d7-savekey-race" });
    const electionId = created.electionId!;

    const keyA = await generateTallyKeyPair();
    const keyB = await generateTallyKeyPair();

    // 窗口：讓兩邊都通過「election.tallyPublicKeyJwk 為 null」的交易外檢查後才放行寫入。
    const lock = await holdElectionLock(electionId, "no key update");
    try {
      const a = as(ADMIN, () => savePublicKey(electionId, keyA.publicKeyJwk, 1));
      await settle();
      const b = as(MODERATOR, () => savePublicKey(electionId, keyB.publicKeyJwk, 2));
      await settle();
      await lock.release();

      const [ra, rb] = await Promise.all([a, b]);
      const okCount = [ra, rb].filter((r) => r.ok).length;
      expect(okCount, "兩次併發儲存應該只有一次成功，另一次要被擋下").toBe(1);
      const failed = [ra, rb].find((r) => !r.ok) as { ok: false; error: string };
      expect(failed.error).toContain("已有開票金鑰");

      const e = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
      const stored = JSON.stringify(e.tallyPublicKeyJwk);
      const storedIsA = stored.includes((keyA.publicKeyJwk as { n: string }).n);
      const storedIsB = stored.includes((keyB.publicKeyJwk as { n: string }).n);
      expect(storedIsA !== storedIsB, "DB 應只留下成功那一次的公鑰").toBe(true);
      expect(storedIsA, "成功回應與 keyShares 應對應到同一次呼叫").toBe(ra.ok);
      expect(e.keyShares, "keyShares 應對應到成功寫入的那一次").toBe(ra.ok ? 1 : 2);

      // 只有成功那一次留下稽核紀錄——被擋下的那次不該留假的痕跡。
      const logs = await prisma.electionAuditLog.count({
        where: { electionId, action: "save_public_key" },
      });
      expect(logs, "只有成功的那次寫 audit log").toBe(1);
    } catch (e) {
      await lock.abort();
      throw e;
    }
  }, 60_000);
});

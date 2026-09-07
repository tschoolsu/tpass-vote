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
import { createHash } from "node:crypto";
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
import { importRoster, removeVoter } from "@/app/admin/elections/[id]/roster/actions";
import { savePublicKey, redoElection } from "@/app/admin/elections/[id]/actions";
import { publishAnnouncement } from "@/app/admin/elections/[id]/announcements/actions";

const CAND = { email: "racecand@test.local", name: "候選人" };
const SLUG = "race";

/** 開一條獨立連線並鎖住某場選舉，回傳「放行」函式。 */
async function holdElectionLock(
  electionId: string,
  mode: "key share" | "share" | "no key update" | "update",
) {
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

describe("D7-11 importRoster：投票結束後不能再匯入名冊（投票中仍可補人）", () => {
  const SLUG = "d7-roster-import";
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
    await advanceTo(electionId, "voting");
  }, 90_000);

  it("投票中仍可補匯入漏掉的選舉人", async () => {
    const before = await prisma.voter.count({ where: { electionId } });
    const imported = await as(ADMIN, () =>
      importRoster(electionId, "late-but-ok@test.local,投票中補人"),
    );
    expect(imported.ok, imported.ok ? "" : imported.error).toBe(true);
    expect(await prisma.voter.count({ where: { electionId } })).toBe(before + 1);
  }, 30_000);

  it("關票後直接呼叫 importRoster，整筆被擋下、Voter 數不變", async () => {
    await advanceTo(electionId, "closed");
    const before = await prisma.voter.count({ where: { electionId } });

    const imported = await as(ADMIN, () =>
      importRoster(electionId, "late-import@test.local,遲到報名"),
    );

    expect(imported.ok, "投票已結束，名冊匯入本應被擋下").toBe(false);
    expect(
      await prisma.voter.count({ where: { electionId } }),
      "Voter 數不該因為被擋下的匯入而改變",
    ).toBe(before);
  }, 30_000);

  it("關票一旦 commit，卡在鎖上的 importRoster 必須讀到新狀態並被擋下，名冊不被插隊寫入", async () => {
    const before = await prisma.voter.count({ where: { electionId } });

    // 狀態仍是 voting：鎖窗模擬「檢查時還沒關票、commit 後才關票」的插隊競態。

    const lock = await holdElectionLock(electionId, "no key update");
    try {
      await lock.client.query(`UPDATE "Election" SET status = 'closed' WHERE id = $1`, [
        electionId,
      ]);

      const importing = as(ADMIN, () =>
        importRoster(electionId, "race-import@test.local,插隊報名"),
      );
      await settle();
      await lock.release();
      const imported = await importing;

      expect(imported.ok, "關票後才 commit，這筆匯入本應被擋下").toBe(false);
      expect(
        await prisma.voter.count({ where: { electionId } }),
        "名冊不該被插隊匯入的資料改變",
      ).toBe(before);
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

  // V2-5（第 3 輪，D11-3 追蹤）：previousDisclosuresSha256／isResubmit 是在交易外的
  // 一般 SELECT 上算的，真正的覆寫卻發生在交易內取得 FOR NO KEY UPDATE 之後。兩位
  // 選委同時重新提交時，兩邊的交易外讀取都不受列鎖阻擋，會同時讀到同一份舊明細——
  // 這裡用鎖窗模擬「B 的重新提交已經在窗口內 commit，C 的交易外讀取卻還停在更早
  // 的版本」，重現稽核鏈記錯上一棒的問題。
  it("重新提交卡在鎖上、鎖放行前另一次提交已覆寫明細：previousDisclosuresSha256 要指向真正被覆寫的那份，不是交易外讀到的舊版", async () => {
    const before = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    const disclosuresA = JSON.parse(JSON.stringify(before.disclosuresJson)) as Array<
      Record<string, unknown>
    >;
    const resultsA = JSON.parse(JSON.stringify(before.resultsJson));
    const shaA = createHash("sha256").update(JSON.stringify(disclosuresA)).digest("hex");

    // 明細 B：形狀不變，只換第一筆的代碼——verifyDisclosures 不會被用到（這裡直接繞過
    // submitResults 模擬「B 的交易已經 commit」，不必真的再走一次驗證）。
    const disclosuresB = disclosuresA.map((d, i) =>
      i === 0 ? { ...d, code: "aaaaaaaaaaaa" } : d,
    );
    const shaB = createHash("sha256").update(JSON.stringify(disclosuresB)).digest("hex");

    const lock = await holdElectionLock(electionId, "no key update");
    try {
      // 鎖窗內用同一條連線（已持有列鎖，不會自己卡自己）把 disclosuresJson 改成 B，
      // 模擬「另一次重新提交」的交易已經走到 UPDATE、只差 COMMIT。
      await lock.client.query(`UPDATE "Election" SET "disclosuresJson" = $1::jsonb WHERE id = $2`, [
        JSON.stringify(disclosuresB),
        electionId,
      ]);

      // C 的重新提交：交易外的 SELECT 在 B commit 之前執行，看到的是舊版 A；
      // 接著卡在 FOR NO KEY UPDATE，直到 B 的鎖窗放行。
      const submittingC = as(MODERATOR, () => submitResults(electionId, resultsA, disclosuresA));
      await settle();
      await lock.release();
      const subC = await submittingC;
      expect(subC.ok, "C 的重新提交本身應該成功").toBe(true);

      const logC = await prisma.electionAuditLog.findFirst({
        where: { electionId, action: "submit_results" },
        orderBy: { createdAt: "desc" },
      });
      const diffC = logC!.diff as Record<string, unknown>;
      expect(diffC.previousDisclosuresSha256, "應指向鎖窗內真正被覆寫的 B，不是交易外讀到的 A").toBe(
        shaB,
      );
      expect(diffC.previousDisclosuresSha256).not.toBe(shaA);
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

// C-4：先查後寫的兩個窗口——公告唯一性、cloneElection 的 slug——原本都可能以未處理例外
// （500）收場。DB 端補了 partial unique index／app 層補了 catch 與重試一次之後，
// 兩者都應該「恰一則落地」或「友善錯誤」，不再是裸露的 Prisma 例外。
describe("C-4：公告唯一性與 cloneElection slug 的併發防線", () => {
  it("兩位選委同時第一次發布結果公告：恰一則落地，另一次拿到友善錯誤而不是例外", async () => {
    await resetDb();
    const created = await makeElection({ slug: "race-ann" });
    const electionId = created.electionId!;
    // 直接把選舉戳到「已彌封、有結果」，跳過完整開票流程——這裡要測的是公告 create 本身
    // 的併發，不是計票。
    await prisma.election.update({
      where: { id: electionId },
      data: { status: "sealed", resultsJson: { candidates: [] } },
    });

    const lock = await holdElectionLock(electionId, "update");
    try {
      const a = as(ADMIN, () => publishAnnouncement(electionId, null, "result", "結果公告甲", "甲版本"));
      await settle();
      const b = as(MODERATOR, () => publishAnnouncement(electionId, null, "result", "結果公告乙", "乙版本"));
      await settle();
      await lock.release();

      const [ra, rb] = await Promise.all([a, b]);

      const oks = [ra, rb].filter((r) => r.ok);
      const fails = [ra, rb].filter((r) => !r.ok) as { ok: false; error: string }[];
      expect(oks.length, "兩位選委同時發布，應恰有一次成功").toBe(1);
      expect(fails.length, "另一次應拿到可讀錯誤而不是丟例外").toBe(1);
      expect(fails[0].error).toBe("這個公告類型已被其他公告佔用，請改為編輯既有那一則");

      expect(
        await prisma.announcement.count({ where: { electionId, legalTag: "result" } }),
        "DB 端 partial unique index：每場至多一則 result 公告",
      ).toBe(1);

      const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
      expect(election.status, "成功那次應把選舉狀態推到 published").toBe("published");
    } catch (e) {
      await lock.abort();
      throw e;
    }
  }, 60_000);

  it("同時按兩次重辦：都成功或其一是友善錯誤，slug 不撞號，沒有未處理例外", async () => {
    await resetDb();
    const created = await makeElection({ slug: "race-redo" });
    const electionId = created.electionId!;
    await generateKeys(electionId, "race-redo");
    await importVoters(electionId, [VOTER_A]);

    // 刻意不用 Promise.allSettled：修法前這裡應該直接以未處理例外（拒絕）收場，
    // 而不是回傳一個 ok:false 的可讀結果——這正是規格要修的問題。
    const [ra, rb] = await Promise.all([
      as(ADMIN, () => redoElection(electionId)),
      as(MODERATOR, () => redoElection(electionId)),
    ]);

    for (const r of [ra, rb]) {
      if (!r.ok) {
        expect(r.error, "失敗要是可讀訊息，不能是裸露的 Prisma 例外字串").not.toMatch(
          /prisma|P2002|constraint|unique/i,
        );
      }
    }

    const oks = [ra, rb].filter((r) => r.ok) as { ok: true; electionId: string }[];
    expect(oks.length, "至少要有一次重辦成功").toBeGreaterThanOrEqual(1);

    const clones = await prisma.election.findMany({
      where: { parentId: electionId, lineage: "redo" },
      select: { slug: true },
    });
    expect(clones.length, "落地的重辦場次數要跟回報成功的次數一致").toBe(oks.length);
    expect(new Set(clones.map((c) => c.slug)).size, "重辦場次的 slug 不可以撞號").toBe(clones.length);
  }, 60_000);

  it("submitResults 首次自動生成 result 公告草稿時撞到別人搶先寫入，交易照樣成功而不是丟未處理例外", async () => {
    await resetDb();
    const SUBMIT_SLUG = "race-submit";
    const created = await makeElection({ slug: SUBMIT_SLUG });
    const electionId = created.electionId!;
    const { publicKeyJwk, keyFiles } = await generateKeys(electionId, SUBMIT_SLUG);
    await importVoters(electionId, [VOTER_A, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(SUBMIT_SLUG, electionId, CAND);
    const [cand] = await approveAll(electionId);
    await advanceTo(electionId, "voting");
    await voteAs(SUBMIT_SLUG, electionId, VOTER_A, publicKeyJwk, {
      type: "choose",
      candidateIds: [cand.id],
    });
    await advanceTo(electionId, "closed");
    await seal(electionId);

    // 另一位選委在同一場選舉搶先建了一則 result 公告草稿——現實中對應
    // saveAnnouncementDraft：它沒有任何狀態守門、交易外 autocommit，窗口極短但存在。
    // 這裡尚未 commit，卡住 submitResults 首次自動生成草稿時要做的 create。
    const other = new Client({ connectionString: TEST_DATABASE_URL });
    await other.connect();
    await other.query("BEGIN");
    await other.query(
      `INSERT INTO "Announcement" (id, "electionId", "legalTag", title, body, "createdAt", "updatedAt")
       VALUES ('race-submit-ann', $1, 'result', '別人的草稿', 'x', now(), now())`,
      [electionId],
    );

    try {
      const submitting = tallyAndSubmit(electionId, SUBMIT_SLUG, keyFiles);
      await settle();
      await other.query("COMMIT");
      await other.end();

      const { submitted } = await submitting;
      expect(submitted.ok, submitted.ok ? "" : submitted.error).toBe(true);

      const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
      expect(election.resultsJson, "撞到公告不該連累結果本身沒有落地").not.toBeNull();

      expect(
        await prisma.announcement.count({ where: { electionId, legalTag: "result" } }),
        "撞到的那則是別人先建的草稿，submitResults 不需要（也不應該）再建一則",
      ).toBe(1);
    } catch (e) {
      await other.query("ROLLBACK").catch(() => {});
      await other.end().catch(() => {});
      throw e;
    }
  }, 90_000);
});

// V2-2（第二輪 D7-1／D7-2）：publishAnnouncement 交易外讀 resultsJson、交易內只用
// updateMany 保護狀態，落地 Office 卻用那份可能已過期的快照；且鎖序與 submitResults
// 相反（先 Announcement 再 Election vs. 先 Election 再 Announcement），併發時可能
// 40P01 死結。
describe("V2-2 publishAnnouncement：交易內持鎖重讀結果，鎖序與 submitResults 一致", () => {
  const SLUG = "v2-2-publish";
  let electionId: string;
  let candAId: string;
  let candBId: string;
  let firstResults: unknown;
  let firstDisclosures: unknown;
  let draftId: string;

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
    candAId = approved[0].id;
    candBId = approved[1].id;
    await advanceTo(electionId, "voting");
    await voteAs(SLUG, electionId, VOTER_A, publicKeyJwk, {
      type: "choose",
      candidateIds: [candAId],
    });
    await voteAs(SLUG, electionId, VOTER_B, publicKeyJwk, {
      type: "choose",
      candidateIds: [candAId],
    });
    await advanceTo(electionId, "closed");
    await seal(electionId);
    const t = await tallyAndSubmit(electionId, SLUG, keyFiles);
    expect(t.submitted.ok, "首次提交結果應成功").toBe(true);
    firstResults = t.results;
    firstDisclosures = t.disclosures;

    const draft = await prisma.announcement.findFirstOrThrow({
      where: { electionId, legalTag: "result" },
    });
    draftId = draft.id;
  }, 120_000);

  it("鎖窗內 resultsJson 被換成第二份結果，publishAnnouncement 落地的 Office 必須是第二份的當選人", async () => {
    const before = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    const draft = await prisma.announcement.findUniqueOrThrow({ where: { id: draftId } });

    // 第二份結果：把當選旗標從甲換成乙（形狀照舊，直接改 DB 快照，模擬另一位選委的
    // submitResults 在鎖窗內插隊 commit 了新結果）。
    const second = JSON.parse(JSON.stringify(before.resultsJson)) as {
      candidates: { candidateId: string; elected: boolean }[];
    };
    for (const c of second.candidates) c.elected = c.candidateId === candBId;

    const lock = await holdElectionLock(electionId, "no key update");
    try {
      // publishAnnouncement 卡在交易內第一步的 SELECT ... FOR NO KEY UPDATE 上。
      const publishing = as(ADMIN, () =>
        publishAnnouncement(electionId, draft.id, "result", draft.title, draft.body),
      );
      await settle();

      // 鎖窗內用同一條連線把 resultsJson 換成第二份結果並 commit（release）。
      await lock.client.query(
        `UPDATE "Election" SET "resultsJson" = $1::jsonb WHERE id = $2`,
        [JSON.stringify(second), electionId],
      );
      await lock.release();

      const pub = await publishing;
      expect(pub.ok, pub.ok ? "" : pub.error).toBe(true);

      const after = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
      expect(after.status, "公告成功應把狀態推到 published").toBe("published");

      const office = await prisma.office.findFirstOrThrow({
        where: { sourceElectionId: electionId },
      });
      const winner = await prisma.candidate.findUniqueOrThrow({ where: { id: candBId } });
      expect(
        office.currentMembers,
        "Office 落地的當選人是交易外那份過期快照（甲），不是鎖定後重讀到的第二份結果（乙）",
      ).toEqual(winner.members);
    } catch (e) {
      await lock.abort();
      throw e;
    }
  }, 90_000);

  it("鎖窗卡超過 30 秒的 DB statement_timeout（不是 Prisma 交易的 10 秒逾時）時要回可讀錯誤，不能讓例外往外丟", async () => {
    // Prisma 交易本身的 10 秒逾時（P2028）不會打斷「已送出、卡在鎖上」的那句 SQL——
    // 真正在 30 秒後把它砍掉的是 src/lib/db.ts 的 statement_timeout=30000，鎖等待
    // 也算在這個逾時裡。拋出的錯誤是 P2010（Raw query failed，底層 57014 canceling
    // statement due to statement timeout），不是 P2028，所以要卡超過 30 秒才驗得到。
    const draft = await prisma.announcement.findUniqueOrThrow({ where: { id: draftId } });

    const lock = await holdElectionLock(electionId, "no key update");
    try {
      const publishing = as(ADMIN, () =>
        publishAnnouncement(electionId, draft.id, "result", draft.title, draft.body),
      );
      await new Promise((r) => setTimeout(r, 31_000));
      await lock.release();

      const pub = await publishing;
      expect(pub.ok, "statement_timeout 逾時應回可讀的 ok:false，不能讓例外往外丟變 500").toBe(
        false,
      );
    } catch (e) {
      await lock.abort();
      throw e;
    }
  }, 45_000);

  it("submitResults 與 publishAnnouncement 同時操作同一則 result 公告：鎖序一致，兩邊都回物件不 throw", async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      // 每輪重演「首次提交後、尚未公告」的窗口：submitResults 的 resubmit 分支與
      // publishAnnouncement 都會去動同一則 draft 公告 + 同一列 Election。
      await prisma.election.update({ where: { id: electionId }, data: { status: "sealed" } });
      await prisma.announcement.update({ where: { id: draftId }, data: { publishedAt: null } });

      const draft = await prisma.announcement.findUniqueOrThrow({ where: { id: draftId } });
      const results = await Promise.allSettled([
        as(ADMIN, () =>
          publishAnnouncement(electionId, draft.id, "result", draft.title, draft.body),
        ),
        as(MODERATOR, () => submitResults(electionId, firstResults, firstDisclosures)),
      ]);

      for (const r of results) {
        expect(
          r.status,
          `第 ${attempt} 次同時操作以未處理例外收場（鎖序不一致造成的 40P01／P2034 沒接住）`,
        ).toBe("fulfilled");
        if (r.status === "fulfilled") {
          expect(r.value, "應回傳可讀的 ok 物件，不是丟例外").toHaveProperty("ok");
        }
      }
    }
  }, 120_000);
});

// V2-2 迴歸（獨立審查發現）：上面那個修法把 FOR NO KEY UPDATE 放在 publishAnnouncement
// 交易第一步、對「所有」公告發布生效，不分 legalTag。但一般公告（legalTag=null）從不動
// Election 那一列，不需要這把鎖——卻因此被 importRoster／removeVoter／castBallot 對
// Election 取的 FOR SHARE 卡住（FOR NO KEY UPDATE 與 FOR SHARE 互斥）。持續整個投票期間
// 都能發的一般公告，因此可能被一次合法的大量名冊匯入（現有交易預算長達 30 秒）擋到
// publishAnnouncement 自己的 10 秒交易逾時，丟出未接住的 P2028 變成 500。
describe("V2-2 迴歸：一般公告不該被 Election 列鎖卡住", () => {
  let electionId: string;

  beforeEach(async () => {
    await resetDb();
    const created = await makeElection({ slug: "v2-2-regression" });
    electionId = created.electionId!;
  });

  it("importRoster 持有的 FOR SHARE 不該卡住一般公告的發布", async () => {
    // FOR SHARE 模擬 importRoster 正在進行中（它對 Election 取的就是這個鎖）。
    // 這個鎖跟 Announcement 建立時 FK 檢查隱含取的 FOR KEY SHARE 相容，
    // 只跟「一般公告也去顯式鎖 Election」這個多餘動作衝突。
    const lock = await holdElectionLock(electionId, "share");
    try {
      const publishing = as(ADMIN, () =>
        publishAnnouncement(electionId, null, null, "投票期間的一般公告", "內容"),
      );
      const settled = await Promise.race([
        publishing.then(() => "resolved" as const),
        settle().then(() => "still-pending" as const),
      ]);
      expect(
        settled,
        "一般公告不需要動 Election 那一列，不該被 importRoster 持有的 FOR SHARE 卡住",
      ).toBe("resolved");

      const r = await publishing;
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    } finally {
      await lock.release();
    }
  }, 15_000);
});

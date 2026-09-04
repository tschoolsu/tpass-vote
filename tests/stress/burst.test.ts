// 「同時灌爆」測試：所有人在同一秒湧進來會怎樣。
//
// 這支測試的假想敵是 2026-09-02 那次事故的三個根因，換到 vote 身上的對應版本：
//   1. 記憶體上限被合法觸發 → 這裡盯 server RSS，看灌爆時會不會逼近 pm2 的上限。
//   2. PostgreSQL 被重啟、pool 沒有 error handler → 這裡在灌爆中途砍掉所有 DB 連線。
//   3. 啟動時搶排他鎖 → 這裡讓大量寫入撞同一批 row，看會不會死鎖或逾時。
// 另外加上選舉系統特有的競態：同一人同時送多張票、投票截止的那一瞬間。
//
// 併發刻意開到遠超連線池上限（src/lib/db.ts 的 max=10、connectionTimeoutMillis=5000），
// 因為真實的投票尖峰就是這樣：公告一發，全校在同一分鐘內湧入。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { APP_URL } from "../helpers/env";
import { as, ADMIN } from "../helpers/session";
import { signTestToken, cookieHeader, type TestIdentity } from "../helpers/jwks";
import {
  advanceTo,
  approveAll,
  generateKeys,
  makeElection,
  publishResult,
  registerAs,
  seal,
  tallyAndSubmit,
} from "../helpers/flow";
import { importRoster } from "@/app/admin/elections/[id]/roster/actions";
import { castBallot } from "@/app/e/[slug]/vote/actions";
import { advanceStatus } from "@/app/admin/elections/[id]/actions";
import { encryptBallot, type BallotPlain } from "@/lib/ballot-crypto";
import { timed } from "../helpers/metrics";
import { appAlive, appLog, appRssMb } from "../helpers/proc";

const VOTERS = Number(process.env.BURST_VOTERS ?? 800);
/** 同時打進來的請求數。連線池只有 10，這裡刻意開 20 倍以上。 */
const BURST = Number(process.env.BURST_CONCURRENCY ?? 250);

const SLUG = "burst-election";
const CANDS: TestIdentity[] = Array.from({ length: 3 }, (_, i) => ({
  email: `burst-cand${i}@test.local`,
  name: `候選人${i}`,
}));
const voters: TestIdentity[] = Array.from({ length: VOTERS }, (_, i) => ({
  email: `burst-voter${i}@test.local`,
  name: `選舉人${i}`,
}));

let electionId: string;
let publicKeyJwk: JsonWebKey;
let keyFiles: Awaited<ReturnType<typeof generateKeys>>["keyFiles"];
let candidateIds: string[] = [];
const rssTrack: { label: string; mb: number | null }[] = [];

function trackRss(label: string) {
  const mb = appRssMb();
  rssTrack.push({ label, mb });
  console.log(`  ▸ RSS after ${label}: ${mb === null ? "?" : `${mb}MB`}`);
}

describe(`同時灌爆（${VOTERS} 人、瞬間併發 ${BURST}）`, () => {
  beforeAll(async () => {
    await resetDb();
    console.log(`\n[灌爆設定] 選舉人 ${VOTERS}・瞬間併發 ${BURST}・連線池上限 10`);
    const created = await makeElection({ slug: SLUG, kind: "grade_rep", seats: 2, maxChoices: 1 });
    if (!created.ok) throw new Error(created.error);
    electionId = created.electionId!;
    const keys = await generateKeys(electionId, SLUG);
    publicKeyJwk = keys.publicKeyJwk;
    keyFiles = keys.keyFiles;

    const raw = [...voters, ...CANDS].map((v) => `${v.email},${v.name}`).join("\n");
    const r = await as(ADMIN, () => importRoster(electionId, raw));
    if (!r.ok) throw new Error(r.error);

    await advanceTo(electionId, "registration");
    for (const c of CANDS) await registerAs(SLUG, electionId, c);
    candidateIds = (await approveAll(electionId)).map((c) => c.id);
    await advanceTo(electionId, "voting");
    trackRss("setup");
  });

  it("投票開放瞬間：全部人同時送票，一張都不能掉", async () => {
    const jobs = await Promise.all(
      voters.map(async (v, i) => ({
        voter: v,
        ciphertext: await encryptBallot(publicKeyJwk, {
          v: 1,
          electionId,
          choice: { type: "choose", candidateIds: [candidateIds[i % candidateIds.length]] },
        } satisfies BallotPlain),
      })),
    );

    // 不用 pool 慢慢餵——真的一次全部丟出去。
    const start = performance.now();
    const settled = await Promise.allSettled(
      jobs.map((job) => as(job.voter, () => castBallot(SLUG, job.ciphertext))),
    );
    const wallMs = performance.now() - start;

    const rejected = settled.filter((s) => s.status === "rejected");
    const refused = settled.filter(
      (s) => s.status === "fulfilled" && !(s.value as { ok: boolean }).ok,
    );
    console.log(
      `  ▸ 一次丟 ${jobs.length} 張票：牆鐘 ${Math.round(wallMs)}ms・` +
        `例外 ${rejected.length}・被拒 ${refused.length}・吞吐 ${Math.round((jobs.length / wallMs) * 1000)}票/秒`,
    );
    if (rejected.length > 0) {
      console.log(`  ▸ 例外樣本：${(rejected[0] as PromiseRejectedResult).reason}`);
    }

    expect(rejected, "有票在連線池排隊時直接爆掉——投票尖峰會掉票").toHaveLength(0);
    expect(refused, "有票被業務邏輯拒絕，但這些人都在名冊內").toHaveLength(0);
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(VOTERS);
    trackRss("投票灌爆");
  });

  it("同一個人同時送 30 張票，票匭只會留下一張", async () => {
    const victim = voters[0];
    const jobs = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        encryptBallot(publicKeyJwk, {
          v: 1,
          electionId,
          choice: { type: "choose", candidateIds: [candidateIds[i % candidateIds.length]] },
        } satisfies BallotPlain),
      ),
    );
    const settled = await Promise.allSettled(
      jobs.map((ct) => as(victim, () => castBallot(SLUG, ct))),
    );
    const failed = settled.filter(
      (s) => s.status === "rejected" || !(s.value as { ok: boolean }).ok,
    );
    console.log(`  ▸ 同一人 30 張並發：失敗 ${failed.length}（upsert 競爭）`);

    const voter = await prisma.voter.findUniqueOrThrow({
      where: { electionId_email: { electionId, email: victim.email } },
    });
    const mine = await prisma.encryptedBallot.count({ where: { voterId: voter.id } });
    expect(mine, "同一人留下超過一張票＝一人一票被打破").toBe(1);
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(VOTERS);
  });

  it("PostgreSQL 連線被砍光（模擬 9/2 的 PG 重啟）之後仍能收票", async () => {
    // 只砍測試庫的連線，開發庫不受影響。
    const killed = await prisma.$queryRawUnsafe<{ pg_terminate_backend: boolean }[]>(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = 't_vote_test' AND pid <> pg_backend_pid()`,
    );
    console.log(`  ▸ 砍掉 ${killed.length} 條 DB 連線`);

    // 服務不應該掛掉，只該重連。
    expect(appAlive(), "砍 DB 連線之後 server process 死了").toBe(true);

    const survivor = voters[1];
    const ct = await encryptBallot(publicKeyJwk, {
      v: 1,
      electionId,
      choice: { type: "blank" },
    } satisfies BallotPlain);

    // 重連可能需要一兩次嘗試，但不該永久失敗。
    let ok = false;
    let lastError = "";
    for (let i = 0; i < 5 && !ok; i++) {
      try {
        const r = await as(survivor, () => castBallot(SLUG, ct));
        ok = r.ok;
        if (!r.ok) lastError = r.error;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    expect(ok, `PG 連線被砍後再也收不到票：${lastError}`).toBe(true);

    // HTTP server 也要能自己回來
    const res = await fetch(`${APP_URL}/e/${SLUG}`);
    expect(res.status, "PG 重連後 HTTP 端仍然壞掉").toBe(200);
    expect(appLog()).not.toContain("uncaughtException");
    trackRss("PG 連線被砍");
  });

  it("投票截止的那一瞬間：一邊關票、一邊還有人在送", async () => {
    const latecomers = voters.slice(2, 2 + Math.min(120, VOTERS - 2));
    const jobs = await Promise.all(
      latecomers.map(async (v) => ({
        voter: v,
        ciphertext: await encryptBallot(publicKeyJwk, {
          v: 1,
          electionId,
          choice: { type: "choose", candidateIds: [candidateIds[0]] },
        } satisfies BallotPlain),
      })),
    );

    // 同時發動：一半的票、以及「推進到 closed」
    const voting = jobs.map((job) => as(job.voter, () => castBallot(SLUG, job.ciphertext)));
    const closing = as(ADMIN, () => advanceStatus(electionId));
    const [closeResult, ...ballots] = await Promise.all([closing, ...voting]);

    expect(closeResult.ok, "截止動作本身失敗了").toBe(true);
    const accepted = ballots.filter((b) => b.ok).length;
    const rejectedAfterClose = ballots.filter((b) => !b.ok).length;
    console.log(`  ▸ 截止瞬間：收下 ${accepted} 張、拒絕 ${rejectedAfterClose} 張`);

    // 關鍵不變量：狀態變成 closed 之後不可以再有票進來。
    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(election.status).toBe("closed");
    const total = await prisma.encryptedBallot.count({ where: { electionId } });
    expect(total, "票匭張數超過名冊人數＝有人投了不只一張").toBeLessThanOrEqual(VOTERS);

    const after = await as(voters[3], () =>
      castBallot(SLUG, jobs[0].ciphertext),
    );
    expect(after.ok, "投票已截止還收得下票").toBe(false);
  });

  it("彌封與開票在大票匭下不會爆記憶體", async () => {
    const sealed = await timed(() => seal(electionId));
    trackRss("彌封");
    const tallied = await timed(() => tallyAndSubmit(electionId, SLUG, keyFiles));
    expect(tallied.value.submitted.ok).toBe(true);
    trackRss("開票");
    console.log(
      `  ▸ 彌封 ${Math.round(sealed.ms)}ms・開票 ${Math.round(tallied.ms)}ms（${VOTERS} 張）`,
    );
  });

  it("結果公告後所有人同時來看結果（最重的讀取路徑）", async () => {
    await publishResult(electionId);
    const before = appRssMb();

    const cookie = cookieHeader(await signTestToken(voters[0]));
    const requests = Array.from({ length: BURST });
    const start = performance.now();
    const settled = await Promise.allSettled(
      requests.map(async () => {
        const res = await fetch(`${APP_URL}/e/${SLUG}/results`, { headers: { Cookie: cookie } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.arrayBuffer()).byteLength;
      }),
    );
    const wallMs = performance.now() - start;
    const failed = settled.filter((s) => s.status === "rejected");
    const sizes = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));

    console.log(
      `  ▸ ${BURST} 個同時請求結果頁：牆鐘 ${Math.round(wallMs)}ms・失敗 ${failed.length}・` +
        `每頁 ${Math.round((sizes[0] ?? 0) / 1024)}KB・總傳輸 ${Math.round(
          sizes.reduce((a, b) => a + b, 0) / 1024 / 1024,
        )}MB`,
    );
    if (failed.length > 0) {
      console.log(`  ▸ 失敗樣本：${(failed[0] as PromiseRejectedResult).reason}`);
    }
    trackRss("結果頁灌爆");

    expect(appAlive(), "灌爆結果頁之後 server 死了").toBe(true);
    expect(
      failed.length / BURST,
      `結果頁在 ${BURST} 併發下失敗率 ${Math.round((failed.length / BURST) * 100)}%`,
    ).toBeLessThan(0.02);

    const after = appRssMb();
    if (before !== null && after !== null) {
      console.log(`  ▸ 結果頁灌爆前後 RSS：${before}MB → ${after}MB`);
      // pm2 對服務設的 max_memory_restart 是 1G（9/2 事故後從 512M 調上來）。
      // 單一服務在尖峰只用到幾百 MB 才有安全邊際。
      expect(after, "灌爆時 RSS 逼近 pm2 的 1G 上限，會觸發重啟迴圈").toBeLessThan(800);
    }
  });

  it("最後回顧記憶體軌跡", () => {
    for (const { label, mb } of rssTrack) {
      expect(mb === null || mb < 900, `${label} 階段 RSS ${mb}MB 過高`).toBe(true);
    }
    console.log(
      `  ▸ RSS 軌跡：${rssTrack.map((r) => `${r.label}=${r.mb ?? "?"}MB`).join(" → ")}`,
    );
  });
});

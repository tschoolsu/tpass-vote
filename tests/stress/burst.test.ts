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
//
// 投票本身一律經 HTTP 打真正跑起來的 next start（tests/helpers/action-http.ts），
// 不在 vitest process 內直接 `import { castBallot }` 呼叫——後者走的是測試 process 自己
// 的 Prisma pool，appRssMb() 盯的 next start 反而在旁邊閒置，量出來的 RSS／連線池數字
// 跟正式服務在投票尖峰的行為無關。castBallot 回傳值是 React Flight 編碼，這裡不完整解析，
// 只靠 callAction 回傳的 ok（body 是否含 `"ok":true` 的子字串比對）判斷業務層成敗，
// 真正的斷言一律回 DB 查副作用——「伺服器說 ok」跟「票真的躺在票匭裡」是兩件事，
// 兩個都要對上。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { APP_URL } from "../helpers/env";
import { as, ADMIN } from "../helpers/session";
import { signTestToken, cookieHeader, type TestIdentity } from "../helpers/jwks";
import { callAction } from "../helpers/action-http";
import {
  advanceTo,
  approveAll,
  generateKeys,
  makeElection,
  publishResult,
  registerAs,
  seal,
  tallyAndSubmit,
  ciphertextFor,
} from "../helpers/flow";
import { importRoster } from "@/app/admin/elections/[id]/roster/actions";
import { advanceStatus } from "@/app/admin/elections/[id]/actions";
import { timed } from "../helpers/metrics";
import { appAlive, appLog, appRssMb } from "../helpers/proc";

const VOTERS = Number(process.env.BURST_VOTERS ?? 800);
/** 同時打進來的請求數。連線池只有 10，這裡刻意開 20 倍以上。 */
const BURST = Number(process.env.BURST_CONCURRENCY ?? 250);

const SLUG = "burst-election";
const VOTE_ROUTE = `/e/${SLUG}/vote`;

/** 投一張票：經 HTTP 打真正的 server action，回傳 HTTP 狀態碼。 */
function castViaHttp(voter: TestIdentity, ciphertext: string) {
  return callAction("castBallot", VOTE_ROUTE, [SLUG, ciphertext], { identity: voter });
}
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
        ciphertext: await ciphertextFor(publicKeyJwk, electionId, { type: "choose", candidateIds: [candidateIds[i % candidateIds.length]] }),
      })),
    );

    // 不用 pool 慢慢餵——真的一次全部丟給伺服器。
    const rssBefore = appRssMb();
    const start = performance.now();
    const settled = await Promise.allSettled(
      jobs.map((job) => castViaHttp(job.voter, job.ciphertext)),
    );
    const wallMs = performance.now() - start;

    const rejected = settled.filter((s) => s.status === "rejected");
    const httpFailed = settled.filter(
      (s) => s.status === "fulfilled" && s.value.status !== 200,
    );
    console.log(
      `  ▸ 一次丟 ${jobs.length} 張票（HTTP）：牆鐘 ${Math.round(wallMs)}ms・` +
        `例外 ${rejected.length}・HTTP 非 200 ${httpFailed.length}・吞吐 ${Math.round((jobs.length / wallMs) * 1000)}票/秒`,
    );
    if (rejected.length > 0) {
      console.log(`  ▸ 例外樣本：${(rejected[0] as PromiseRejectedResult).reason}`);
    }
    if (httpFailed.length > 0) {
      const sample = (httpFailed[0] as PromiseFulfilledResult<{ status: number }>).value;
      console.log(`  ▸ HTTP 失敗樣本：狀態碼 ${sample.status}`);
    }

    expect(rejected, "有票在連線池排隊時直接爆掉——投票尖峰會掉票").toHaveLength(0);
    expect(httpFailed, "有票被伺服器用非 200 拒絕，但這些人都在名冊內").toHaveLength(0);
    // 請求真的打到伺服器的證據：DB 票數剛好等於名冊人數。settled.length 恆等於
    // jobs.length（Promise.allSettled 的定義），拿它斷言證明不了任何事，這裡不寫。
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(VOTERS);

    // 光看總數等於 VOTERS 抓不到「伺服器回 ok，交易卻沒真的 commit」——逐一核對每個人：
    // 回 ok 就該在票匭裡看到這次送出的密文，沒回 ok 就不該有票。
    const ballotRows = await prisma.encryptedBallot.findMany({
      where: { electionId },
      select: { voterId: true, ciphertext: true },
    });
    const voterRows = await prisma.voter.findMany({
      where: { electionId, email: { in: voters.map((v) => v.email) } },
      select: { id: true, email: true },
    });
    const voterIdByEmail = new Map(voterRows.map((v) => [v.email, v.id]));
    const ciphertextByVoterId = new Map(ballotRows.map((b) => [b.voterId, b.ciphertext]));
    jobs.forEach((job, i) => {
      const res = settled[i];
      if (res.status !== "fulfilled") return; // 例外已經在上面 rejected 斷言裡處理
      const voterId = voterIdByEmail.get(job.voter.email)!;
      const stored = ciphertextByVoterId.get(voterId) ?? null;
      if (res.value.ok) {
        expect(stored, `${job.voter.email} 的請求回 ok，票匭裡卻沒有這張票`).toBe(job.ciphertext);
      } else {
        expect(stored, `${job.voter.email} 的請求沒回 ok，票匭裡卻多了一張票`).toBeNull();
      }
    });

    console.log(`  ▸ RSS 灌爆前後：${rssBefore ?? "?"}MB → ${appRssMb() ?? "?"}MB`);
    trackRss("投票灌爆");
  });

  it("同一個人同時送 200 張票，票匭只會留下一張", async () => {
    const SAME_PERSON_BURST = 200;
    const victim = voters[0];
    const jobs = await Promise.all(
      Array.from({ length: SAME_PERSON_BURST }, (_, i) =>
        ciphertextFor(publicKeyJwk, electionId, { type: "choose", candidateIds: [candidateIds[i % candidateIds.length]] }),
      ),
    );
    const rssBefore = appRssMb();
    const start = performance.now();
    const settled = await Promise.allSettled(jobs.map((ct) => castViaHttp(victim, ct)));
    const wallMs = performance.now() - start;

    const rejected = settled.filter((s) => s.status === "rejected");
    // castBallot 裡沒被 CastRejected 攔下的例外（deadlock、serialization failure…）會直接
    // throw 到 action handler，對 fetch action 而言就是 HTTP 500——不用解析 Flight body
    // 也看得到。業務層的正常拒絕（ok:false）仍然是 200，不算在這裡面。
    const httpFailed = settled.filter(
      (s) => s.status === "fulfilled" && s.value.status !== 200,
    );
    console.log(
      `  ▸ 同一人 ${SAME_PERSON_BURST} 張並發（HTTP）：牆鐘 ${Math.round(wallMs)}ms・` +
        `例外 ${rejected.length}・HTTP 非 200（疑似 deadlock/serialization）${httpFailed.length}`,
    );
    if (rejected.length > 0) {
      console.log(`  ▸ 例外樣本：${(rejected[0] as PromiseRejectedResult).reason}`);
    }

    const voter = await prisma.voter.findUniqueOrThrow({
      where: { electionId_email: { electionId, email: victim.email } },
    });
    const mine = await prisma.encryptedBallot.count({ where: { voterId: voter.id } });
    expect(mine, "同一人留下超過一張票＝一人一票被打破").toBe(1);
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(VOTERS);
    expect(rejected, "有請求連 HTTP 層都沒回應").toHaveLength(0);
    expect(httpFailed, "castBallot 的 $transaction 在高併發同一人重投下出現 deadlock/serialization failure（伺服器回了非 200）").toHaveLength(0);
    console.log(`  ▸ RSS 灌爆前後：${rssBefore ?? "?"}MB → ${appRssMb() ?? "?"}MB`);
    trackRss("同一人重投灌爆");
  });

  it("PostgreSQL 連線被砍光（模擬 9/2 的 PG 重啟）之後仍能收票", async () => {
    // 只砍測試庫的連線，開發庫不受影響。pid <> pg_backend_pid() 排除的是「正在執行這句砍線
    // 指令」的那條連線本身——src/lib/db.ts 沒有設 application_name，沒有更精細的方法能只挑
    // 「伺服器」的連線；測試 process 自己 Prisma pool 裡其他閒置連線會一起被砍，但那只是
    // 測試工具的連線，下一次查詢自動重連，不影響斷言。真正要驗證的是「伺服器」（next start）
    // 的連線池能不能自己恢復——所以下面收票改經 HTTP 打伺服器，不是測試 process 自己呼叫。
    const killed = await prisma.$queryRawUnsafe<{ pg_terminate_backend: boolean }[]>(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = 't_vote_test' AND pid <> pg_backend_pid()`,
    );
    console.log(`  ▸ 砍掉 ${killed.length} 條 DB 連線`);
    const rssBefore = appRssMb();

    // 服務不應該掛掉，只該重連。
    expect(appAlive(), "砍 DB 連線之後 server process 死了").toBe(true);

    const survivor = voters[1];
    const ct = await ciphertextFor(publicKeyJwk, electionId, { type: "blank" });

    // 重連可能需要一兩次嘗試，但不該永久失敗。HTTP 200 只代表 action 正常返回、不代表票真的
    // 進了 DB（castBallot 對業務拒絕也回 200），所以每次都直接查 DB 當作真正的判準。
    //
    // 判準不能用 votedAt：survivor 在第一個 case（全員投票）就已經投過票，votedAt 早非
    // null，拿它當迴圈條件會讓迴圈直接跳過、一次 HTTP 都沒送出也能通過斷言。改成比對
    // 「這次砍線後送出的這張新密文」有沒有真的覆寫進他的票位——這才是「砍線後還能收票」。
    let lastStatus = -1;
    let stored = false;
    for (let i = 0; i < 5 && !stored; i++) {
      const res = await castViaHttp(survivor, ct);
      lastStatus = res.status;
      const voter = await prisma.voter.findUniqueOrThrow({
        where: { electionId_email: { electionId, email: survivor.email } },
      });
      const ballot = await prisma.encryptedBallot.findUnique({ where: { voterId: voter.id } });
      stored = ballot?.ciphertext === ct;
    }
    expect(stored, `PG 連線被砍後再也收不到票（最後一次 HTTP ${lastStatus}）`).toBe(true);

    // HTTP server 也要能自己回來。連線池裡其他沒被上面那次收票用到的閒置連線，可能還沒被
    // 伺服器發現已經斷線——要等它真的被拿去用一次才會踢掉重建，所以這裡跟上面一樣重試幾次，
    // 而不是假設第一次就恢復。
    let getStatus = -1;
    for (let i = 0; i < 5 && getStatus !== 200; i++) {
      getStatus = (await fetch(`${APP_URL}/e/${SLUG}`)).status;
    }
    expect(getStatus, "PG 重連後 HTTP 端仍然壞掉").toBe(200);
    expect(appLog()).not.toContain("uncaughtException");
    console.log(`  ▸ RSS 灌爆前後：${rssBefore ?? "?"}MB → ${appRssMb() ?? "?"}MB`);
    trackRss("PG 連線被砍");
  });

  it("投票截止的那一瞬間：一邊關票、一邊還有人在送", async () => {
    const latecomers = voters.slice(2, 2 + Math.min(120, VOTERS - 2));
    const jobs = await Promise.all(
      latecomers.map(async (v) => ({
        voter: v,
        ciphertext: await ciphertextFor(publicKeyJwk, electionId, { type: "choose", candidateIds: [candidateIds[0]] }),
      })),
    );

    // 這批人在第一個 case（全員投票）就已經投過一次，票位不是空的——先記下競速前的舊密文，
    // 之後才分得清「密文沒變＝被拒絕、維持舊票」（正常）跟「密文變成別的東西＝被寫壞」（不正常）。
    const raceVoters = await prisma.voter.findMany({
      where: { electionId, email: { in: latecomers.map((v) => v.email) } },
      select: { id: true, email: true },
    });
    const beforeBallots = await prisma.encryptedBallot.findMany({
      where: { voterId: { in: raceVoters.map((v) => v.id) } },
      select: { voterId: true, ciphertext: true },
    });
    const beforeCtByVoterId = new Map(beforeBallots.map((b) => [b.voterId, b.ciphertext]));

    // 同時發動：一半的票（HTTP，打真正的伺服器）、以及「推進到 closed」（選委在後台按的
    // in-process admin action——這不是投票尖峰的一部分，不必跟著改走 HTTP）。
    // 這裡要測的是關票競態本身，不是 D2-3／D12-1 的截止時間閘門，而 makeElection 預設窗口
    // 還沒到期，所以跟 advanceTo helper 一樣以 ADMIN（本測試環境的超級管理員）附理由強制關票。
    const rssBefore = appRssMb();
    const voting = jobs.map((job) => castViaHttp(job.voter, job.ciphertext));
    const closing = as(ADMIN, () => advanceStatus(electionId, "壓力測試：強制關票以驗證競態"));
    const [closeResult, ...responses] = await Promise.all([closing, ...voting]);

    expect(closeResult.ok, "截止動作本身失敗了").toBe(true);
    // castBallot 對業務拒絕（截止、名冊外…）跟成功一樣回 200，狀態碼分不出誰收下誰被拒；
    // 「請求真的打到伺服器」只看這裡：所有請求都要有正常 HTTP 回應，不能連線層就爆掉。
    const httpOk = responses.filter((r) => r.status === 200).length;
    console.log(`  ▸ 截止瞬間：${responses.length} 個請求打到伺服器・HTTP 200 有 ${httpOk} 個`);
    expect(httpOk, "有請求連 HTTP 層都沒正常回應——關票競態把連線搞壞了").toBe(responses.length);

    // 關鍵不變量：狀態變成 closed 之後不可以再有票進來。
    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(election.status).toBe("closed");
    const total = await prisma.encryptedBallot.count({ where: { electionId } });
    expect(total, "票匭張數超過名冊人數＝有人投了不只一張").toBeLessThanOrEqual(VOTERS);

    // callAction 現在會回傳 ok（有沒有真的判定成功），不必再靠「密文屬於兩個可能值之一」
    // 這種弱斷言去猜誰贏了——直接核對「回 ok 的，密文就該是這次送出的值；沒回 ok 的，密文
    // 就該原封不動」，抓得到「伺服器回 ok，但交易其實回滾／被關票競態插隊」這種情況。
    const raceBallots = await prisma.encryptedBallot.findMany({
      where: { voterId: { in: raceVoters.map((v) => v.id) } },
      select: { voterId: true, ciphertext: true },
    });
    const ciphertextByVoterId = new Map(raceBallots.map((b) => [b.voterId, b.ciphertext]));
    let accepted = 0;
    jobs.forEach((job, i) => {
      const res = responses[i];
      const voterId = raceVoters.find((v) => v.email === job.voter.email)!.id;
      const stored = ciphertextByVoterId.get(voterId) ?? null;
      const beforeCt = beforeCtByVoterId.get(voterId) ?? null;
      if (res.ok) {
        accepted++;
        expect(stored, `${job.voter.email} 的請求回 ok，票位密文卻不是這次送出的值`).toBe(
          job.ciphertext,
        );
      } else {
        expect(stored, `${job.voter.email} 的請求沒回 ok，票位密文卻被改成這次送出的值`).toBe(
          beforeCt,
        );
      }
    });
    console.log(
      `  ▸ ${latecomers.length} 位競速投票人裡，這次請求被接受覆寫 ${accepted} 張，其餘維持舊票或未投過`,
    );

    // 截止之後補送一張：這個人不該再改得動票匭。這裡不能用「votedAt 是不是 null」判斷——
    // voters[3] 也在前面「投票開放瞬間」那個 case 投過票了，votedAt 早就非 null；真正該守的
    // 不變量是「送出後密文完全沒變」，不管截止前它有沒有投過。
    const target = await prisma.voter.findUniqueOrThrow({
      where: { electionId_email: { electionId, email: voters[3].email } },
    });
    const before = await prisma.encryptedBallot.findUnique({ where: { voterId: target.id } });
    const lateRes = await castViaHttp(voters[3], jobs[0].ciphertext);
    const after = await prisma.encryptedBallot.findUnique({ where: { voterId: target.id } });
    expect(lateRes.ok, "投票已截止，這張補送的票卻回 ok").toBe(false);
    expect(after?.ciphertext ?? null, "投票已截止，票匭裡的密文卻被改寫了").toBe(
      before?.ciphertext ?? null,
    );
    console.log(`  ▸ RSS 灌爆前後：${rssBefore ?? "?"}MB → ${appRssMb() ?? "?"}MB`);
    trackRss("截止瞬間");
  });

  it("彌封與開票在大票匭下耗時合理", async () => {
    // seal()／tallyAndSubmit() 是 in-process 直接呼叫（見檔頭說明），不是經 HTTP 打伺服器，
    // 這裡量的是「伺服器」process 的 RSS，量到的其實是伺服器閒置時的數字，跟這兩個操作
    // 實際吃掉多少記憶體無關——不再假裝那是伺服器的用量，只留執行耗時。
    const sealed = await timed(() => seal(electionId));
    const tallied = await timed(() => tallyAndSubmit(electionId, SLUG, keyFiles));
    expect(tallied.value.submitted.ok).toBe(true);
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

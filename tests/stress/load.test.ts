// 壓力測試：把一場「全校規模」的選舉從灌名冊跑到結果頁渲染，量每一段的成本。
//
// 為什麼是這幾段：投票是併發寫入（DB upsert 競爭）、彌封是一次性大 JSON 寫入、
// 開票是 O(票數) 的 RSA 解密、結果頁要一次渲染整份去識別化明細——這四個是
// 票數一多就會先痛的地方，其他都是常數成本。
//
// 斷言只設「離譜門檻」（明顯退化才紅），數字本身靠 console 輸出給人看。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { APP_URL } from "../helpers/env";
import { as, ADMIN } from "../helpers/session";
import type { TestIdentity } from "../helpers/jwks";
import { signTestToken, cookieHeader } from "../helpers/jwks";
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
import { encryptBallot, type BallotPlain } from "@/lib/ballot-crypto";
import { runPool, summarize, timed, report } from "../helpers/metrics";

const VOTERS = Number(process.env.STRESS_VOTERS ?? 500);
const CONCURRENCY = Number(process.env.STRESS_CONCURRENCY ?? 32);
const HTTP_REQUESTS = Number(process.env.STRESS_HTTP_REQUESTS ?? 100);

const SLUG = "stress-election";
const CANDIDATES: TestIdentity[] = Array.from({ length: 4 }, (_, i) => ({
  email: `stress-cand${i}@test.local`,
  name: `壓測候選人${i}`,
}));

describe(`壓力測試（${VOTERS} 位選舉人、併發 ${CONCURRENCY}）`, () => {
  let electionId: string;
  let publicKeyJwk: JsonWebKey;
  let keyFiles: Awaited<ReturnType<typeof generateKeys>>["keyFiles"];
  let candidateIds: string[] = [];
  const voters: TestIdentity[] = Array.from({ length: VOTERS }, (_, i) => ({
    email: `stress-voter${i}@test.local`,
    name: `選舉人${i}`,
  }));

  beforeAll(async () => {
    await resetDb();
    console.log(`\n[壓測設定] 選舉人 ${VOTERS}・併發 ${CONCURRENCY}・HTTP 請求 ${HTTP_REQUESTS}`);
    const created = await makeElection({ slug: SLUG, kind: "grade_rep", seats: 3, maxChoices: 1 });
    if (!created.ok) throw new Error(created.error);
    electionId = created.electionId!;
    const keys = await generateKeys(electionId, SLUG);
    publicKeyJwk = keys.publicKeyJwk;
    keyFiles = keys.keyFiles;
  });

  it("名冊匯入", async () => {
    const raw = [...voters, ...CANDIDATES].map((v) => `${v.email},${v.name}`).join("\n");
    const { ms, value } = await timed(() => as(ADMIN, () => importRoster(electionId, raw)));
    expect(value.ok).toBe(true);

    const perRow = ms / (VOTERS + CANDIDATES.length);
    report("名冊匯入", summarize([ms]), {
      rows: VOTERS + CANDIDATES.length,
      "每筆": `${Math.round(perRow * 100) / 100}ms`,
    });
    expect(perRow, "每筆名冊寫入超過 20ms，分批 upsert 的批次大小可能要調").toBeLessThan(20);
  });

  it("候選人登記與核准", async () => {
    await advanceTo(electionId, "registration");
    const { ms } = await timed(async () => {
      for (const c of CANDIDATES) await registerAs(SLUG, electionId, c);
    });
    const approved = await approveAll(electionId);
    candidateIds = approved.map((c) => c.id);
    expect(candidateIds.length).toBe(CANDIDATES.length);
    report("候選人登記", summarize([ms]), { 人數: CANDIDATES.length });
  });

  it("併發投票", async () => {
    await advanceTo(electionId, "voting");

    // 先把所有密文與 token 準備好，這樣量到的是「伺服器收票」的成本，
    // 不是「瀏覽器加密」的成本——那一段本來就分散在每個人自己的裝置上。
    const prep = await timed(async () =>
      Promise.all(
        voters.map(async (v, i) => {
          const plain: BallotPlain = {
            v: 1,
            electionId,
            choice: { type: "choose", candidateIds: [candidateIds[i % candidateIds.length]] },
          };
          return { voter: v, ciphertext: await encryptBallot(publicKeyJwk, plain) };
        }),
      ),
    );
    report("瀏覽器端加密（參考值）", summarize([prep.ms]), {
      每張: `${Math.round((prep.ms / VOTERS) * 100) / 100}ms`,
    });

    const { samplesMs, wallMs, errors } = await runPool(prep.value, CONCURRENCY, async (job) => {
      const r = await as(job.voter, () => castBallot(SLUG, job.ciphertext));
      if (!r.ok) throw new Error(r.error);
    });

    expect(errors, `有 ${errors.length} 張票失敗：${errors.slice(0, 3).join(" / ")}`).toHaveLength(
      0,
    );
    const stats = summarize(samplesMs);
    report("收票（castBallot）", stats, {
      牆鐘: `${Math.round(wallMs)}ms`,
      吞吐: `${Math.round((VOTERS / wallMs) * 1000)}票/秒`,
    });

    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(VOTERS);
    expect(stats.p95Ms, "收一張票的 p95 超過 1 秒，投票尖峰會排隊").toBeLessThan(1000);
  });

  it("重投覆寫不會讓票匭長大", async () => {
    const revoters = voters.slice(0, Math.min(50, VOTERS));
    const jobs = await Promise.all(
      revoters.map(async (v) => ({
        voter: v,
        ciphertext: await encryptBallot(publicKeyJwk, {
          v: 1,
          electionId,
          choice: { type: "blank" },
        } satisfies BallotPlain),
      })),
    );
    const { samplesMs, errors } = await runPool(jobs, CONCURRENCY, async (job) => {
      const r = await as(job.voter, () => castBallot(SLUG, job.ciphertext));
      if (!r.ok) throw new Error(r.error);
    });
    expect(errors).toHaveLength(0);
    report("重投覆寫", summarize(samplesMs));
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(VOTERS);
  });

  it("彌封（洗牌 + 大 JSON 寫入 + 銷毀連結）", async () => {
    await advanceTo(electionId, "closed");
    const { ms } = await timed(() => seal(electionId));
    report("彌封", summarize([ms]), { 票數: VOTERS });

    const e = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect((e.sealedBox as string[]).length).toBe(VOTERS);
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(0);
    expect(ms, "彌封超過 30 秒，票匭 JSON 的寫入方式要重想").toBeLessThan(30_000);
  });

  it("開票：解密、計票、產生明細、提交驗證", async () => {
    const { ms, value } = await timed(() => tallyAndSubmit(electionId, SLUG, keyFiles));
    const { results, disclosures, submitted } = value;
    expect(submitted.ok, submitted.ok ? "" : submitted.error).toBe(true);
    expect(results.totalBallots).toBe(VOTERS);
    expect(disclosures.length).toBe(VOTERS);

    report("開票全程", summarize([ms]), {
      每張: `${Math.round((ms / VOTERS) * 100) / 100}ms`,
      有效: results.validCount,
      廢票: results.blankCount,
    });
    // 開票是選委在瀏覽器裡做的，慢一點可以忍，但不能慢到讓人以為當掉。
    expect(ms / VOTERS, "平均每張票開票成本超過 50ms，全校規模會等太久").toBeLessThan(50);
  });

  it("結果頁：一次渲染整份去識別化明細", async () => {
    await publishResult(electionId);

    const cold = await timed(() => fetch(`${APP_URL}/e/${SLUG}/results`));
    expect(cold.value.status).toBe(200);
    const html = await cold.value.text();
    const bytesPerBallot = html.length / VOTERS;
    report("結果頁（未登入・首次）", summarize([cold.ms]), {
      HTML: `${Math.round(html.length / 1024)}KB`,
      每張票: `${Math.round(bytesPerBallot)}B`,
    });

    const admin = cookieHeader(await signTestToken(ADMIN));
    const warm = await runPool(Array.from({ length: HTTP_REQUESTS }), 16, async () => {
      const res = await fetch(`${APP_URL}/e/${SLUG}/results`, { headers: { Cookie: admin } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.arrayBuffer();
    });
    expect(warm.errors).toHaveLength(0);
    report("結果頁（登入・含名冊）", summarize(warm.samplesMs), {
      吞吐: `${Math.round((HTTP_REQUESTS / warm.wallMs) * 1000)}req/秒`,
    });

    // 結果頁的大小必須與票數脫鉤：明細與名冊都只渲染前 PREVIEW_ROWS 筆，
    // 完整資料走 CSV 下載端點。曾經全量下發，3000 票時頁面 320KB、250 併發下
    // 服務 RSS 衝到 800MB（逼近 pm2 的 1G 重啟門檻）——這條斷言就是為了不再發生。
    expect(
      html.length,
      `結果頁 ${Math.round(html.length / 1024)}KB：明細或名冊又被全量塞進頁面了`,
    ).toBeLessThan(200_000);

    const rosterStats = summarize(warm.samplesMs);
    expect(rosterStats.p95Ms, "結果頁（含名冊）p95 超過 1 秒").toBeLessThan(1000);
  });

  it("投票頁在票數已多時仍然快", async () => {
    const token = cookieHeader(await signTestToken(voters[0]));
    const { samplesMs, errors } = await runPool(
      Array.from({ length: HTTP_REQUESTS }),
      16,
      async () => {
        const res = await fetch(`${APP_URL}/e/${SLUG}`, { headers: { Cookie: token } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.arrayBuffer();
      },
    );
    expect(errors).toHaveLength(0);
    const stats = summarize(samplesMs);
    report("選舉頁（登入）", stats);
    expect(stats.p95Ms, "選舉頁 p95 超過 2 秒").toBeLessThan(2000);
  });
});

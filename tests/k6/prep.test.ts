// 給 k6 用的資料前置：建兩場選舉（一場開著投票用來打 /vote，一場已結束
// 用來打 /results 這條最重的讀取路徑），灌 N 位選舉人名冊，把每個人的
// 通行證 cookie 簽好、連同 slug 一起吐成 JSON 給 k6 的 SharedArray 讀。
//
// 只準備資料，不驗證業務邏輯——業務邏輯的正確性已經在 tests/integration、
// tests/stress 裡用真正的 server action 呼叫測過了。這裡純粹是「把 HTTP 層
// 需要的長駐 server + 已登入身分」生出來。
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { as, ADMIN } from "../helpers/session";
import { signTestToken, cookieHeader, startJwksServer, type TestIdentity } from "../helpers/jwks";
import { K6_TEST_PORTS } from "./env";
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

const N = Number(process.env.K6_VOTERS ?? 150);
const VOTE_SLUG = "k6-vote";
const RESULTS_SLUG = "k6-results";
const OUT_DIR = path.join(process.cwd(), "tests/k6/data");

describe("k6 前置資料", () => {
  let jwks: { close: () => Promise<void> } | null = null;

  beforeAll(async () => {
    // requireSession 驗章時真的會 fetch AUTH_JWKS_URL，所以即使這裡是 in-process
    // 呼叫 server action、不透過 HTTP，也要先把 JWKS stub 起起來。
    // 之後給 k6 打的長駐 app（tests/k6/start-server.mjs）會在這支測試跑完後
    // 另外啟動同一個 port 的 JWKS stub。
    jwks = await startJwksServer(K6_TEST_PORTS.jwks);
  });

  afterAll(async () => {
    await jwks?.close();
  });

  it(`準備 ${N} 位選舉人的通行證＋兩場選舉`, async () => {
    await resetDb();

    const voters: TestIdentity[] = Array.from({ length: N }, (_, i) => ({
      email: `k6-voter${i}@test.local`,
      name: `選舉人${i}`,
    }));
    const cands: TestIdentity[] = Array.from({ length: 3 }, (_, i) => ({
      email: `k6-cand${i}@test.local`,
      name: `候選人${i}`,
    }));

    // 場次一：voting 中，給 k6 打 GET /e/<slug>/vote（含 session 查詢的讀取成本）。
    const voteElection = await makeElection({
      slug: VOTE_SLUG,
      kind: "grade_rep",
      seats: 2,
      maxChoices: 1,
    });
    expect(voteElection.ok, voteElection.error).toBe(true);
    const voteElectionId = voteElection.electionId!;
    await generateKeys(voteElectionId, VOTE_SLUG);
    const rawVote = [...voters, ...cands].map((v) => `${v.email},${v.name}`).join("\n");
    const importedVote = await as(ADMIN, () => importRoster(voteElectionId, rawVote));
    expect(importedVote.ok).toBe(true);
    await advanceTo(voteElectionId, "registration");
    for (const c of cands) await registerAs(VOTE_SLUG, voteElectionId, c);
    await approveAll(voteElectionId);
    await advanceTo(voteElectionId, "voting");

    // 場次二：已結束、已開票、已公告，給 k6 打 GET /e/<slug>/results（最重的讀取路徑）。
    const resultsElection = await makeElection({
      slug: RESULTS_SLUG,
      kind: "grade_rep",
      seats: 2,
      maxChoices: 1,
    });
    expect(resultsElection.ok, resultsElection.error).toBe(true);
    const resultsElectionId = resultsElection.electionId!;
    const keys = await generateKeys(resultsElectionId, RESULTS_SLUG);
    const rawResults = [...voters, ...cands].map((v) => `${v.email},${v.name}`).join("\n");
    const importedResults = await as(ADMIN, () => importRoster(resultsElectionId, rawResults));
    expect(importedResults.ok).toBe(true);
    await advanceTo(resultsElectionId, "registration");
    for (const c of cands) await registerAs(RESULTS_SLUG, resultsElectionId, c);
    const approved = await approveAll(resultsElectionId);
    await advanceTo(resultsElectionId, "voting");

    // 實際灌票，讓結果頁不是空的。
    for (let i = 0; i < voters.length; i++) {
      const ciphertext = await encryptBallot(keys.publicKeyJwk, {
        v: 1,
        electionId: resultsElectionId,
        choice: { type: "choose", candidateIds: [approved[i % approved.length].id] },
      } satisfies BallotPlain);
      const r = await as(voters[i], () => castBallot(RESULTS_SLUG, ciphertext));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    }

    await advanceTo(resultsElectionId, "closed");
    await seal(resultsElectionId);
    await tallyAndSubmit(resultsElectionId, RESULTS_SLUG, keys.keyFiles);
    await publishResult(resultsElectionId);

    // 簽好每個人的 cookie，連同兩個 slug 一起吐出去給 k6 讀。
    const identities = await Promise.all(
      voters.map(async (v) => ({
        email: v.email,
        cookie: cookieHeader(await signTestToken(v)),
      })),
    );

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      path.join(OUT_DIR, "identities.json"),
      JSON.stringify({ voteSlug: VOTE_SLUG, resultsSlug: RESULTS_SLUG, identities }, null, 2),
      "utf8",
    );

    const ballotCount = await prisma.election.findUniqueOrThrow({
      where: { id: resultsElectionId },
      select: { resultsJson: true },
    });
    console.log(
      `[k6-prep] 準備完成：${N} 位選舉人・voteSlug=${VOTE_SLUG}（voting 中）・` +
        `resultsSlug=${RESULTS_SLUG}（已公告，${ballotCount.resultsJson ? "有結果" : "無結果！"}）`,
    );
  }, 120_000);
});

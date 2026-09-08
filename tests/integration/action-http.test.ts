// action-http helper 本身的驗收：證明 callAction 真的走到伺服器的 server action handler，
// 而不是自己在測試 process 裡演一齣戲。這是壓測改走 HTTP（tests/stress/burst.test.ts）的前提。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import type { TestIdentity } from "../helpers/jwks";
import { callAction } from "../helpers/action-http";
import {
  advanceTo,
  approveAll,
  generateKeys,
  importVoters,
  makeElection,
  registerAs,
} from "../helpers/flow";
import { encryptBallot } from "@/lib/ballot-crypto";

const SLUG = "action-http";
const VOTER: TestIdentity = { email: "action-http-voter@test.local", name: "投票人" };
const CAND: TestIdentity = { email: "action-http-cand@test.local", name: "候選人" };
// (b)(c) 各自需要一個沒投過票的人，才能乾淨地斷言「DB 沒有票」——同一人會被 (a) 的票蓋過去。
// 名冊在投票開放後不能再匯入（D7-11），所以這兩人得跟 VOTER/CAND 一起在投票開放前匯入。
const SECOND_VOTER: TestIdentity = { email: "action-http-voter2@test.local", name: "投票人乙" };
const THIRD_VOTER: TestIdentity = { email: "action-http-voter3@test.local", name: "投票人丙" };

describe("callAction：HTTP 層真的能打到 server action", () => {
  let electionId: string;
  let publicKeyJwk: JsonWebKey;
  const routePath = `/e/${SLUG}/vote`;

  beforeAll(async () => {
    await resetDb();
    const created = await makeElection({ slug: SLUG, kind: "other", seats: 1, maxChoices: 1 });
    if (!created.ok) throw new Error(created.error);
    electionId = created.electionId!;
    const keys = await generateKeys(electionId, SLUG);
    publicKeyJwk = keys.publicKeyJwk;

    await importVoters(electionId, [VOTER, CAND, SECOND_VOTER, THIRD_VOTER]);
    await advanceTo(electionId, "registration");
    await registerAs(SLUG, electionId, CAND);
    await approveAll(electionId);
    await advanceTo(electionId, "voting");
  });

  it("(a) 合法選舉人＋正確 Origin：200，票真的進了 DB", async () => {
    const { ciphertext } = await encryptBallot(publicKeyJwk, { electionId, choice: { type: "blank" } });

    const res = await callAction("castBallot", routePath, [SLUG, ciphertext], { identity: VOTER });
    console.log(`  ▸ (a) 正確 Origin：HTTP ${res.status}`);
    expect(res.status).toBe(200);

    const voter = await prisma.voter.findUniqueOrThrow({
      where: { electionId_email: { electionId, email: VOTER.email } },
    });
    expect(voter.hasVoted).toBe(true);
    // 票匭沒有 voterId，查不到「這個人的票」——只能驗「這張密文進了這場的票匭」。
    // 這正是本系統要的性質，不是測試寫得不夠精確。
    const ballots = await prisma.encryptedBallot.findMany({
      where: { electionId },
      select: { ciphertext: true },
    });
    expect(ballots.map((b) => b.ciphertext)).toContain(ciphertext);
  });

  it("(b) 同樣請求但 Origin 是別的網域：Next 內建 CSRF 擋下，DB 不動", async () => {
    const before = await prisma.encryptedBallot.count({ where: { electionId } });
    const { ciphertext } = await encryptBallot(publicKeyJwk, { electionId, choice: { type: "blank" } });

    const res = await callAction("castBallot", routePath, [SLUG, ciphertext], {
      identity: SECOND_VOTER,
      origin: "https://evil.example",
    });
    console.log(`  ▸ (b) 錯誤 Origin（https://evil.example）：HTTP ${res.status}`);
    expect(res.status).not.toBe(200);

    const after = await prisma.encryptedBallot.count({ where: { electionId } });
    expect(after, "CSRF 應該被 Next 擋在 action handler，票不該進 DB").toBe(before);
    const voter = await prisma.voter.findUniqueOrThrow({
      where: { electionId_email: { electionId, email: SECOND_VOTER.email } },
    });
    expect(voter.hasVoted, "CSRF 被擋下，hasVoted 不該被設").toBe(false);
  });

  it("(c) 沒有 Cookie：requireSession 導向登入，DB 不動", async () => {
    const before = await prisma.encryptedBallot.count({ where: { electionId } });
    const { ciphertext } = await encryptBallot(publicKeyJwk, { electionId, choice: { type: "blank" } });

    const res = await callAction("castBallot", routePath, [SLUG, ciphertext], { identity: null });
    console.log(`  ▸ (c) 無 Cookie：HTTP ${res.status}`);
    // requireSession 的 redirect() 對 fetch action 而言會回 200＋x-action-redirect header
    // （見 next/dist/server/app-render/action-handler.js 對 isRedirectError 的處理），
    // 不是傳統意義的錯誤碼——所以不斷言狀態碼，直接看「有沒有真的投進去」。
    expect(res.status).toBe(200);

    const after = await prisma.encryptedBallot.count({ where: { electionId } });
    expect(after, "未登入不該收得下票").toBe(before);
    const voter = await prisma.voter.findUniqueOrThrow({
      where: { electionId_email: { electionId, email: THIRD_VOTER.email } },
    });
    expect(voter.hasVoted).toBe(false);
  });
});

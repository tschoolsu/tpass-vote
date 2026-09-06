// D1-1／D1-2：session.email 大小寫正規化收斂到 guard.ts 的 requireSession()。
// auth 簽出的 email claim 不保證恆為小寫，同一個真人（同一個 Google sub）在不同情境下
// 拿到的 session.email 大小寫可能不同。這裡驗證：候選人登記（createdBy）與罷免連署
// （signerEmail）在大小寫不同的兩次 token 下，仍被視為同一人。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { as } from "../helpers/session";
import { APP_URL } from "../helpers/env";
import { advanceTo, generateKeys, makeElection, registerAs } from "../helpers/flow";
import { signRecall, withdrawSignature } from "@/app/e/[slug]/recall/actions";
import { signTestToken, cookieHeader, type TestIdentity } from "../helpers/jwks";

// 同一個真人＝同一個 Google sub，但兩次登入拿到的 email 大小寫不同。
const SAME_SUB = "sub-same-real-person";
const LOWER: TestIdentity = { email: "case.person@test.local", name: "同一人（小寫）", sub: SAME_SUB };
const UPPER: TestIdentity = { email: "Case.Person@Test.Local", name: "同一人（大寫變體）", sub: SAME_SUB };

describe("身分大小寫正規化", () => {
  describe("候選人登記 createdBy", () => {
    const slug = "d1-case-candidate";
    let electionId: string;

    beforeAll(async () => {
      await resetDb();
      const created = await makeElection({ slug });
      electionId = created.electionId!;
      await generateKeys(electionId, slug);
      // 名冊不需要——登記不查名冊（見 registration-policy），這裡故意不 importVoters。
      await advanceTo(electionId, "registration");
    }, 60_000);

    it("同一人用大小寫不同的 email 登記兩次，第二次應被業務規則拒絕", async () => {
      const first = await registerAs(slug, electionId, LOWER);
      expect(first.ok, first.ok ? "" : first.error).toBe(true);

      const second = await registerAs(slug, electionId, UPPER);
      expect(second.ok).toBe(false);

      const rows = await prisma.candidate.findMany({ where: { electionId } });
      expect(rows.length).toBe(1);
    }, 30_000);
  });

  describe("罷免連署 signerEmail", () => {
    const slug = "d1-case-recall";
    let electionId: string;

    beforeAll(async () => {
      await resetDb();
      // 直接建 kind=recall/status=petition 的最小場次，繞開 initiateRecall 對 Office
      // §27（就職滿 2 個月）等前置條件的要求——這裡只測 signRecall 本身的 unique 行為。
      const election = await prisma.election.create({
        data: {
          slug,
          title: "身分正規化測試用罷免案",
          kind: "recall",
          status: "petition",
          ballotMode: "approval",
          seats: 1,
          maxChoices: 1,
        },
      });
      electionId = election.id;
    }, 30_000);

    it("同一人用大小寫不同的 email 連署兩次，只留一筆；另一種大小寫也能撤回", async () => {
      const first = await as(LOWER, () => signRecall(slug));
      expect(first.ok, first.ok ? "" : first.error).toBe(true);

      const second = await as(UPPER, () => signRecall(slug));
      expect(second.ok).toBe(false);

      const rows = await prisma.recallSignature.findMany({ where: { electionId } });
      expect(rows.length).toBe(1);

      // 用大寫變體撤回，應該能刪掉那筆用小寫連署的紀錄（正規化後是同一個 signerEmail）。
      const withdrawn = await as(UPPER, () => withdrawSignature(slug));
      expect(withdrawn.ok, withdrawn.ok ? "" : withdrawn.error).toBe(true);
      const remaining = await prisma.recallSignature.findMany({ where: { electionId } });
      expect(remaining.length).toBe(0);
    }, 30_000);
  });

  describe("連署後用不同大小寫身分看頁面，狀態要跟 DB 一致", () => {
    const slug = "d1-case-recall-page";

    beforeAll(async () => {
      await resetDb();
      await prisma.election.create({
        data: {
          slug,
          title: "身分正規化頁面測試用罷免案",
          kind: "recall",
          status: "petition",
          ballotMode: "approval",
          seats: 1,
          maxChoices: 1,
        },
      });
    }, 30_000);

    it("小寫身分連署後，大寫身分看頁面應顯示「已連署」並給撤回鈕，而不是「我要連署」", async () => {
      const signed = await as(LOWER, () => signRecall(slug));
      expect(signed.ok, signed.ok ? "" : signed.error).toBe(true);

      const res = await fetch(`${APP_URL}/e/${slug}`, {
        headers: { Cookie: cookieHeader(await signTestToken(UPPER)) },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("已連署");
      expect(html).toContain("撤回連署");
      expect(html).not.toContain("我要連署");
    }, 30_000);
  });
});

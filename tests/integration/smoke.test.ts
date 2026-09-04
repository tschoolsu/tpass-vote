// 基礎設施自檢：測試環境本身是不是對的。這個檔失敗時，其他整合測試的結果全部不可信。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { APP_URL } from "../helpers/env";
import { as, ADMIN, VOTER_A } from "../helpers/session";
import { requireAdmin, requireSession, ForbiddenError } from "@/lib/guard";
import { captureRedirect } from "../helpers/redirect";

describe("測試環境自檢", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("prisma 連的是測試庫", async () => {
    const [row] = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
      "SELECT current_database()",
    );
    expect(row.current_database).toBe("t_vote_test");
  });

  it("HTTP server 活著，而且連的也是測試庫", async () => {
    const election = await prisma.election.create({
      data: { slug: "probe-db-binding", title: "探測用選舉", kind: "other", status: "registration" },
    });
    const res = await fetch(`${APP_URL}/e/probe-db-binding`);
    expect(res.status, "app 查不到測試庫裡的選舉＝它連到別的資料庫，測試結果不可信").toBe(200);
    expect(await res.text()).toContain("探測用選舉");
    await prisma.election.delete({ where: { id: election.id } });
  });

  it("測試簽的 token 過得了真正的驗章（沒有 mock guard）", async () => {
    const session = await as(ADMIN, () => requireAdmin());
    expect(session.email).toBe(ADMIN.email);
  });

  it("一般使用者過 requireSession 但被 requireAdmin 擋下", async () => {
    const session = await as(VOTER_A, () => requireSession());
    expect(session.email).toBe(VOTER_A.email);
    await expect(as(VOTER_A, () => requireAdmin())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("未登入時 requireSession 導向登入頁", async () => {
    const url = await captureRedirect(() => as(null, () => requireSession("/admin")));
    expect(url).toContain("/authorize");
  });
});

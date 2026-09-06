// D10-2：importRoster 分批多交易寫入，稽核紀錄在迴圈之後——中途斷線（或任何一批寫入失敗）
// 會留下半套名冊，且完全沒有留痕。整次匯入應該包在單一交易裡，要嘛全進、要嘛全退。
//
// 用一個掛在 Voter 表上的 trigger 模擬「中途斷線／DB 錯誤」：第二批裡藏一列命中 sentinel
// email 的資料，只要那一列被寫入就直接讓 DB 端丟例外——不必真的斷線也能可靠、快速重現
// 「匯入途中失敗」這個條件，且失敗的是 DB 這一層，跟真正的斷線一樣是「不受應用程式控制」。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { as, ADMIN } from "../helpers/session";
import { importRoster } from "@/app/admin/elections/[id]/roster/actions";
import { makeElection } from "../helpers/flow";

const BATCH_SIZE = 500; // 與 actions.ts 內的分批大小一致，確保 sentinel 落在第二批。

describe("匯入名冊：中途失敗不留半套名冊", () => {
  const slug = "roster-import-atomicity";
  let electionId: string;

  beforeAll(async () => {
    await resetDb();
    const created = await makeElection({ slug });
    expect(created.ok, created.error).toBe(true);
    electionId = created.electionId!;
  }, 60_000);

  afterEach(async () => {
    // 每個 it 都自建、自清，避免這支 trigger 污染同一支資料庫的其他測試檔。
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS boom_on_voter ON "Voter"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS boom_on_voter_fn()`);
  });

  it("第二批寫入中途失敗時，第一批不留下、audit log 也沒有半筆", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION boom_on_voter_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.email = 'boom@test.local' THEN
          RAISE EXCEPTION '模擬匯入中途斷線';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER boom_on_voter BEFORE INSERT OR UPDATE ON "Voter"
      FOR EACH ROW EXECUTE FUNCTION boom_on_voter_fn();
    `);

    // 第一批（0~499）全部合法；第二批（500~599）裡第 10 筆是會炸的 sentinel。
    const total = BATCH_SIZE + 100;
    const lines: string[] = [];
    for (let i = 0; i < total; i++) {
      const email = i === BATCH_SIZE + 10 ? "boom@test.local" : `roster-atomic-${i}@test.local`;
      lines.push(`${email},名冊${i}`);
    }

    const auditBefore = await prisma.electionAuditLog.count({ where: { electionId } });

    await expect(as(ADMIN, () => importRoster(electionId, lines.join("\n")))).rejects.toThrow();

    const voterCount = await prisma.voter.count({ where: { electionId } });
    const auditAfter = await prisma.electionAuditLog.count({ where: { electionId } });

    // 修法前：第一批的 500 筆已經 commit，這裡會是 500 而不是 0，斷言失敗。
    expect(voterCount).toBe(0);
    expect(auditAfter).toBe(auditBefore);
  }, 45_000);
});

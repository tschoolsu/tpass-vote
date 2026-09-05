// 測試資料庫工具。env 由 setup.ts 先設好，所以這裡 import 的 prisma 已經連到 t_vote_test。
import { prisma } from "@/lib/db";
import { TEST_DATABASE_URL } from "./env";

const TABLES = [
  "EncryptedBallot",
  "RecallSignature",
  "Announcement",
  "Candidate",
  "Voter",
  "ElectionAuditLog",
  "OfficeEditLog",
  "Upload",
  "Election",
  "Office",
];

/**
 * 清空測試庫。開頭先確認連的真的是測試庫——接錯庫的 TRUNCATE 會清掉開發資料，
 * 這種錯誤只能靠事前擋，不能靠事後補救。
 */
export async function resetDb(): Promise<void> {
  if (!process.env.DATABASE_URL?.includes("t_vote_test")) {
    throw new Error(
      `拒絕清庫：DATABASE_URL 不是測試庫（期望含 t_vote_test，實際 ${process.env.DATABASE_URL}）`,
    );
  }
  const [{ current_database }] = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
    "SELECT current_database()",
  );
  if (current_database !== "t_vote_test") {
    throw new Error(`拒絕清庫：連線指向 ${current_database}，不是 t_vote_test`);
  }
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

export { prisma, TEST_DATABASE_URL };

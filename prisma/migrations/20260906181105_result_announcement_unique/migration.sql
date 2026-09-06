-- CreateIndex
CREATE INDEX "EncryptedBallot_electionId_idx" ON "EncryptedBallot"("electionId");

-- CreateIndex
-- 每場至多一則 legalTag='result' 的公告：Prisma schema 語法不支援 partial index，
-- 這裡手寫 raw SQL 補 DB 端的最後一道防線（見 schema.prisma 的 Announcement model 註解）。
-- 其餘 legalTag（null／其他值）不受此限，故用 WHERE 子句只約束 'result' 這一種。
CREATE UNIQUE INDEX "Announcement_electionId_result_key" ON "Announcement" ("electionId") WHERE "legalTag" = 'result';

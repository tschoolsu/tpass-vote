-- Announcement: 從「固定三則」改為「自由公告流」。
-- kind（first|second|result，NOT NULL，每場唯一）→ legalTag（nullable；null=一般公告，
-- first|second|result=法定里程碑，每場至多一則由 action 層強制，不再靠 DB unique 約束）。
-- pre-launch、DB 可重建，不保留舊資料語意轉換，直接 rename + 放寬 NOT NULL。

-- DropIndex
DROP INDEX "Announcement_electionId_kind_key";

-- AlterTable
ALTER TABLE "Announcement" RENAME COLUMN "kind" TO "legalTag";
ALTER TABLE "Announcement" ALTER COLUMN "legalTag" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Announcement_electionId_idx" ON "Announcement"("electionId");

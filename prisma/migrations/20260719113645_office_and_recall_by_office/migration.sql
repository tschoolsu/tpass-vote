-- AlterTable
ALTER TABLE "Election" ADD COLUMN     "officeId" TEXT,
ADD COLUMN     "recallLeadEmail" TEXT,
ADD COLUMN     "recallLeadName" TEXT,
ADD COLUMN     "recallTargetOfficeId" TEXT;

-- CreateTable
CREATE TABLE "Office" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "currentMembers" JSONB NOT NULL,
    "isVacant" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "sourceElectionId" TEXT,
    "termValidCount" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Office_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficeEditLog" (
    "id" TEXT NOT NULL,
    "officeId" TEXT NOT NULL,
    "editorEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "diff" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfficeEditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Office_isVacant_idx" ON "Office"("isVacant");

-- CreateIndex
CREATE INDEX "OfficeEditLog_officeId_createdAt_idx" ON "OfficeEditLog"("officeId", "createdAt");

-- CreateIndex
CREATE INDEX "Election_recallTargetOfficeId_idx" ON "Election"("recallTargetOfficeId");

-- AddForeignKey
ALTER TABLE "Election" ADD CONSTRAINT "Election_officeId_fkey" FOREIGN KEY ("officeId") REFERENCES "Office"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Election" ADD CONSTRAINT "Election_recallTargetOfficeId_fkey" FOREIGN KEY ("recallTargetOfficeId") REFERENCES "Office"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeEditLog" ADD CONSTRAINT "OfficeEditLog_officeId_fkey" FOREIGN KEY ("officeId") REFERENCES "Office"("id") ON DELETE CASCADE ON UPDATE CASCADE;

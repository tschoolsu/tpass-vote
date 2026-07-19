-- AlterTable
ALTER TABLE "Election" ADD COLUMN     "lineage" TEXT,
ADD COLUMN     "recallDefense" TEXT,
ADD COLUMN     "recallReason" TEXT,
ADD COLUMN     "recallTargetCandidateId" TEXT;

-- CreateTable
CREATE TABLE "RecallSignature" (
    "id" TEXT NOT NULL,
    "electionId" TEXT NOT NULL,
    "signerEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecallSignature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecallSignature_electionId_idx" ON "RecallSignature"("electionId");

-- CreateIndex
CREATE UNIQUE INDEX "RecallSignature_electionId_signerEmail_key" ON "RecallSignature"("electionId", "signerEmail");

-- AddForeignKey
ALTER TABLE "RecallSignature" ADD CONSTRAINT "RecallSignature_electionId_fkey" FOREIGN KEY ("electionId") REFERENCES "Election"("id") ON DELETE CASCADE ON UPDATE CASCADE;

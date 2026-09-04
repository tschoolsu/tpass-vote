-- CreateIndex
CREATE UNIQUE INDEX "Candidate_electionId_createdBy_key" ON "Candidate"("electionId", "createdBy");

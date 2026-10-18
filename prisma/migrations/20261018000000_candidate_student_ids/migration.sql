-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "studentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

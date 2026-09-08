-- 拿掉重投，並讓票匭在投票期間就不含任何指向選舉人的欄位（§26-1 Ⅳ）。
--
-- 這份是手寫的，不是 `prisma migrate dev` 產的。自動產生的版本會把 votedAt → hasVoted
-- 當成「DROP 一欄、ADD 另一欄」，所有歷史場次的 §26-1 Ⅴ 法定名冊會全部歸零成「未投票」。
-- CI 的 migrate deploy 是對空庫跑的，抓不到這種資料遺失，只能靠這裡先 backfill。
--
-- ⚠️ 部署時機必須在兩場選舉「之間」，不能跨在一場投票中間。EncryptedBallot.id 的預設
-- 從 cuid() 換成 uuid(4)（cuid 前綴含時間、可排序），既有列保留原本的 cuid——同一場
-- 選舉裡若一半是 cuid、一半是 uuid，光看 id 格式就分得出誰先投誰後投。

-- Voter：votedAt（最後一次投票時間）→ hasVoted（只記有無）
ALTER TABLE "Voter" ADD COLUMN "hasVoted" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Voter" SET "hasVoted" = ("votedAt" IS NOT NULL);
ALTER TABLE "Voter" DROP COLUMN "votedAt";

-- EncryptedBallot：砍掉 voterId↔ciphertext 的連結本身，以及會洩漏投票順序的 updatedAt。
-- 密文（ciphertext）原封不動保留。
ALTER TABLE "EncryptedBallot" DROP CONSTRAINT "EncryptedBallot_voterId_fkey";
DROP INDEX "EncryptedBallot_voterId_key";
ALTER TABLE "EncryptedBallot" DROP COLUMN "voterId";
ALTER TABLE "EncryptedBallot" DROP COLUMN "updatedAt";

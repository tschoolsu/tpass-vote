-- 選舉軟刪除：null=正常，非 null=管理員隱藏。資料完全保留，不做實體刪除。
ALTER TABLE "Election" ADD COLUMN "hiddenAt" TIMESTAMP(3);

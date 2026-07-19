-- Upload.kind：區分公開大頭照（photo）／私密附件（attachment，預設值，涵蓋既有資料列）。
ALTER TABLE "Upload" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'attachment';

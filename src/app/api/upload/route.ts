// 檔案上傳端點：候選人登記附件（學生證影本等）上傳前先打這裡拿 upload id，
// 再把 id 帶進 Candidate.attachments。一律驗 session、檢查目標選舉存在、擋超大檔／不明類型。
// 照抄 tpass-form/src/app/api/upload/route.ts 的模式，拿掉問卷特有的題型/accept 判斷。
import { NextResponse } from "next/server";
import { getSession } from "@/lib/tpass-auth";
import { prisma } from "@/lib/db";
import { newStorageKey, putObject } from "@/lib/storage";

// 單一使用者對單一選舉的上傳數上限（防灌爆儲存空間；正常登記遠低於此）。
const MAX_UPLOADS_PER_USER_PER_ELECTION = 20;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// 候選人附件（學生證影本等）允許的類型；伺服器端擋，前端 <input accept> 只是 UX。
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get("file");
  const electionId = form.get("electionId");

  if (!(file instanceof File) || typeof electionId !== "string" || !electionId) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) {
    return NextResponse.json({ error: "election not found" }, { status: 404 });
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }

  const mime = file.type || "application/octet-stream";
  if (!ALLOWED_MIME.includes(mime)) {
    return NextResponse.json({ error: "file type not allowed" }, { status: 415 });
  }

  // 每人每選舉上傳配額（防灌檔）。
  const uploadedCount = await prisma.upload.count({
    where: { electionId, uploaderSub: session.sub },
  });
  if (uploadedCount >= MAX_UPLOADS_PER_USER_PER_ELECTION) {
    return NextResponse.json({ error: "upload quota exceeded" }, { status: 429 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const storageKey = newStorageKey();
  await putObject(storageKey, buffer, mime);

  const upload = await prisma.upload.create({
    data: {
      electionId,
      storageKey,
      filename: file.name,
      mime,
      size: file.size,
      uploaderSub: session.sub,
    },
    select: { id: true, filename: true },
  });

  return NextResponse.json({ id: upload.id, filename: upload.filename });
}

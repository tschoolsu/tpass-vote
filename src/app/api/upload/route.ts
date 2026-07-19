// 檔案上傳端點：候選人登記附件（學生證影本等）、候選人大頭照上傳前都先打這裡拿 upload id，
// 再把 id 帶進 Candidate.attachments / members[].photo。一律驗 session、檢查目標選舉存在、
// 擋超大檔／不明類型。照抄 tpass-form/src/app/api/upload/route.ts 的模式，拿掉問卷特有的題型/accept 判斷。
//
// kind 參數（form field，預設 attachment）：
//   attachment：學生證影本等私密附件，走 /api/files/[id]（admin-only）下載，MIME 含 pdf。
//   photo     ：候選人公開大頭照，走 /api/photos/[id]（免 admin）顯示，MIME 只收 image，
//               因為會被公開路徑吐出去顯示，不能收 pdf 之類非圖片類型。
import { NextResponse } from "next/server";
import { getSession } from "@/lib/tpass-auth";
import { prisma } from "@/lib/db";
import { newStorageKey, putObject } from "@/lib/storage";

// 單一使用者對單一選舉的上傳數上限（防灌爆儲存空間；正常登記遠低於此）。
const MAX_UPLOADS_PER_USER_PER_ELECTION = 20;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// 候選人附件（學生證影本等）允許的類型；伺服器端擋，前端 <input accept> 只是 UX。
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
// 公開大頭照只收圖片：這個檔會被 /api/photos/[id] 公開吐出去渲染，不能是 pdf 等非圖片類型。
const ALLOWED_PHOTO_MIME = ["image/jpeg", "image/png", "image/webp"];
const UPLOAD_KINDS = ["attachment", "photo"] as const;
type UploadKind = (typeof UPLOAD_KINDS)[number];

function isUploadKind(v: unknown): v is UploadKind {
  return typeof v === "string" && (UPLOAD_KINDS as readonly string[]).includes(v);
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get("file");
  const electionId = form.get("electionId");
  const kindRaw = form.get("kind");
  const kind: UploadKind = isUploadKind(kindRaw) ? kindRaw : "attachment";

  if (!(file instanceof File) || typeof electionId !== "string" || !electionId) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const election = await prisma.election.findFirst({ where: { id: electionId, hiddenAt: null } });
  if (!election) {
    return NextResponse.json({ error: "election not found" }, { status: 404 });
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }

  const mime = file.type || "application/octet-stream";
  const allowedMime = kind === "photo" ? ALLOWED_PHOTO_MIME : ALLOWED_MIME;
  if (!allowedMime.includes(mime)) {
    return NextResponse.json({ error: "file type not allowed" }, { status: 415 });
  }

  // 每人每選舉上傳配額（防灌檔；photo 與 attachment 共用同一個額度）。
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
      kind,
    },
    select: { id: true, filename: true },
  });

  return NextResponse.json({ id: upload.id, filename: upload.filename });
}

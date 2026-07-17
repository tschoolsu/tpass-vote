// 下載上傳檔：候選人登記附件屬個資，只開放管理員（選委會）。
// 照抄 tpass-form/src/app/api/files/[id]/route.ts；vote 的 Election 無 ownerSub 概念，
// 所以直接用 isAdmin 把關，不像 form 再收斂到單一 owner。
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/tpass-auth";
import { isAdmin } from "@/config/admin";
import { prisma } from "@/lib/db";
import { getObject } from "@/lib/storage";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/files/[id]">) {
  const session = await getSession();
  if (!session || !(await isAdmin(session.email))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await getObject(upload.storageKey);
  if (!body) return NextResponse.json({ error: "gone" }, { status: 410 });

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": upload.mime,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(upload.filename)}`,
    },
  });
}

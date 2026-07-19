// 候選人大頭照公開端點：選罷法第二十二條要求選票載明候選人相片，這條路徑因此故意不擋
// 登入／管理員——任何人都要能在選票、候選卡上看到相片。
//
// 安全邊界（務必維持）：只吐 upload.kind === "photo" 的檔；非 photo（含學生證影本等私密
// 附件）一律回 404，跟「查無此檔」無法區分，杜絕拿這條路徑側錄 attachment id 偷看附件。
// 私密附件維持走 /api/files/[id]（admin-only），這條路徑完全不碰、不共用邏輯。
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getObject } from "@/lib/storage";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/photos/[id]">) {
  const { id } = await ctx.params;
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload || upload.kind !== "photo") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await getObject(upload.storageKey);
  if (!body) return NextResponse.json({ error: "gone" }, { status: 410 });

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": upload.mime,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(upload.filename)}`,
      // 相片內容不會變（沒有覆寫上傳這回事），可放心長快取。
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}

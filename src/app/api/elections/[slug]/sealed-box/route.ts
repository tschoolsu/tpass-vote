// 彌封快照公開端點：選罷法 §26-1 Ⅵ 要求數位選舉「關係其運作之其他相關資訊應公開之」——
// 光公開 sealedHash 不夠，要有人拿得到快照本體才驗算得了。
//
// 安全邊界：只在結果已公告（status="published"）且未被隱藏時吐出；快照內容是密文，
// 沒有開票私鑰解不開，而私鑰從不落地伺服器。未公告的場次一律 404，與「查無此選舉」無法區分。
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/elections/[slug]/sealed-box">,
) {
  const { slug } = await ctx.params;
  const election = await prisma.election.findFirst({
    where: { slug, hiddenAt: null, status: "published" },
    select: { slug: true, sealedBox: true, sealedHash: true, sealedAt: true },
  });
  if (!election || !Array.isArray(election.sealedBox)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const payload = {
    election: election.slug,
    sealedHash: election.sealedHash,
    sealedAt: election.sealedAt,
    ballots: election.sealedBox,
  };

  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="sealed-box-${election.slug}.json"`,
    },
  });
}

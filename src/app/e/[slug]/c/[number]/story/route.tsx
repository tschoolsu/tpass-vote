// IG 限動用的 1080×1920 分享圖，候選人頁的「下載限動圖」按鈕直接連到這裡。
// 以附件下載：手機上點了就是存圖，不會只在分頁裡開一張圖讓人不知道怎麼存。
import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { findPublicCandidate } from "@/lib/public-candidate";
import { StoryCard, loadShareCard, renderCached, shareCardFonts } from "@/lib/share-card";

export async function GET(_req: NextRequest, ctx: RouteContext<"/e/[slug]/c/[number]/story">) {
  const { slug, number } = await ctx.params;
  const data = await findPublicCandidate(slug, number);
  if (!data) return new Response(null, { status: 404 });

  const png = await renderCached(
    `story:${data.candidate.id}:${data.candidate.updatedAt.getTime()}`,
    async () =>
      new ImageResponse(<StoryCard card={await loadShareCard(data)} />, {
        width: 1080,
        height: 1920,
        fonts: await shareCardFonts(),
      }),
  );
  const filename = `${data.election.title}-${data.candidate.number}號.png`;
  return new Response(png, {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "public, max-age=300",
    },
  });
}

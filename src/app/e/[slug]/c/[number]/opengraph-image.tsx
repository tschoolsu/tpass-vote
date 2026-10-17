// 候選人頁的連結預覽圖：貼到 LINE／Discord／Messenger 時出現的那張卡。
// IG 限動不吃連結預覽，那邊走同層 story/route.tsx 的直式圖。
import { ImageResponse } from "next/og";
import { findPublicCandidate } from "@/lib/public-candidate";
import { OgCard, loadShareCard, renderCached, shareCardFonts } from "@/lib/share-card";

export const alt = "候選人分享卡";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string; number: string }>;
}) {
  const { slug, number } = await params;
  const data = await findPublicCandidate(slug, number);
  if (!data) return new Response(null, { status: 404 });

  const png = await renderCached(
    `og:${data.candidate.id}:${data.candidate.updatedAt.getTime()}`,
    async () =>
      new ImageResponse(<OgCard card={await loadShareCard(data)} />, {
        ...size,
        fonts: await shareCardFonts(),
      }),
  );
  return new Response(png, {
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=300" },
  });
}

// 進行中的選舉清單，給 T-Pass portal 首頁掛橫幅用（portal 在伺服器端抓，不經瀏覽器）。
// 只吐「登記中／投票中」且公開的場次，欄位跟選舉詳情頁本來就公開的資訊同一層級，不用登入。
// 網址由 portal 自己用 slug 組，不在這裡給——portal 不必信任這支 API 回來的連結。
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// 沒讀 request 也沒有動態參數的 GET 會在 build 時被預先算死，這支要每次查。
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await prisma.election.findMany({
    where: { hiddenAt: null, status: { in: ["registration", "voting"] } },
    orderBy: { createdAt: "asc" },
    select: { slug: true, title: true, status: true, registrationEndsAt: true, votingEndsAt: true },
  });

  const elections = rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    status: r.status,
    endsAt: (r.status === "registration" ? r.registrationEndsAt : r.votingEndsAt)?.toISOString() ?? null,
  }));

  return NextResponse.json(
    { elections },
    // portal 那邊也有自己的 60 秒快取；這裡的標頭是給中間的 Cloudflare／nginx 看的。
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}

// 投票暨未投票選舉人名冊（§26-1 Ⅴ）的下載端點。
//
// 與明細不同，名冊是具名的，所以**要登入才給**——法規要求向會員公開，不是向全網公開。
// 同樣不塞進結果頁：幾千筆 <tr> 乘上結果公告後的併發，記憶體會很難看。
import { NextResponse, type NextRequest } from "next/server";
import { tpass } from "@/config/auth";
import { prisma } from "@/lib/db";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/elections/[slug]/roster">) {
  const session = await tpass.getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { slug } = await ctx.params;
  const election = await prisma.election.findFirst({
    where: { slug, hiddenAt: null, status: "published" },
    select: { id: true },
  });
  if (!election) return NextResponse.json({ error: "not found" }, { status: 404 });

  const voters = await prisma.voter.findMany({
    where: { electionId: election.id },
    select: { name: true, email: true, hasVoted: true },
    orderBy: [{ name: "asc" }, { email: "asc" }],
  });

  // CSV 公式注入防護：姓名是 admin 貼上的自由文字，若以 = + - @ 或 tab／CR 開頭，
  // Excel/Sheets 會當公式執行——前綴一個單引號中和它（Excel 顯示時會吃掉這個單引號）。
  const guardCsvFormula = (s: string) => (/^[-=+@\t\r]/.test(s) ? `'${s}` : s);

  const rows = [
    "選舉人,投票狀態",
    ...voters.map((v) => {
      const raw = v.name?.trim() || v.email.split("@")[0];
      const label = guardCsvFormula(raw).replace(/"/g, '""');
      return `"${label}",${v.hasVoted ? "已投票" : "未投票"}`;
    }),
  ];
  return new NextResponse(`﻿${rows.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="roster-${slug}.csv"`,
    },
  });
}

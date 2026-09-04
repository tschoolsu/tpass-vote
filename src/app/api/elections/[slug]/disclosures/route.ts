// 去識別化選票明細（§26-1 Ⅳ、Ⅴ）的資料端點。
//
// 為什麼不把整份明細塞進結果頁：全校在結果公告後同時來看，每頁多幾百 KB 就會把
// 服務的記憶體推到 pm2 的重啟門檻（壓力測試量過）。頁面只渲染前幾十筆，
// 要全部的人從這裡下載，要查自己那張票的人用 ?code= 查單筆。
//
// 安全邊界：只在結果已公告時開放；明細本身已去識別（代碼與選舉人的連結在彌封時銷毀），
// 所以不需要登入即可取得——法規要求的就是「公開」。
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import type { DisclosureEntry } from "@/lib/disclosure";

interface CandidateRow {
  id: string;
  number: number | null;
  members: unknown;
}

function labelOf(kind: string, candidates: CandidateRow[]): Map<string, string> {
  return new Map(
    candidates.map((c) => {
      const members = (Array.isArray(c.members) ? c.members : []) as { name?: string }[];
      const names =
        kind === "leader" && members.length >= 2
          ? `${members[0]?.name ?? "?"}・${members[1]?.name ?? "?"}（副手）`
          : members.map((m) => m.name ?? "?").join("、");
      return [c.id, `${c.number !== null ? `${c.number} 號・` : ""}${names || "（未填姓名）"}`];
    }),
  );
}

function describe(entry: DisclosureEntry, labels: Map<string, string>): string {
  const label = (id: string) => labels.get(id) ?? id;
  switch (entry.kind) {
    case "choose":
      return (entry.candidateIds ?? []).map(label).join("、") || "（無）";
    case "approval":
      return (
        Object.entries(entry.approvals ?? {})
          .map(([id, agree]) => `${label(id)}：${agree ? "同意" : "不同意"}`)
          .join("・") || "（無）"
      );
    case "blank":
      return "廢票（不圈選）";
    default:
      return "無效票";
  }
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/elections/[slug]/disclosures">) {
  const { slug } = await ctx.params;
  const election = await prisma.election.findFirst({
    where: { slug, hiddenAt: null, status: "published" },
    select: {
      kind: true,
      disclosuresJson: true,
      candidates: {
        where: { status: "approved" },
        orderBy: { number: "asc" },
        select: { id: true, number: true, members: true },
      },
    },
  });
  if (!election || !Array.isArray(election.disclosuresJson)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const entries = election.disclosuresJson as unknown as DisclosureEntry[];
  const labels = labelOf(election.kind, election.candidates);

  // 單筆查詢：投票人拿收據來核對自己那一票。
  const code = req.nextUrl.searchParams.get("code")?.trim().toLowerCase();
  if (code) {
    const found = entries.find((e) => e.code === code);
    if (!found) return NextResponse.json({ found: false }, { status: 404 });
    return NextResponse.json({ found: true, code: found.code, summary: describe(found, labels) });
  }

  const rows = ["代碼,內容", ...entries.map((e) => `${e.code},"${describe(e, labels).replace(/"/g, '""')}"`)];
  return new NextResponse(`﻿${rows.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="disclosures-${slug}.csv"`,
    },
  });
}

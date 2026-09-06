// 去識別化選票明細（§26-1 Ⅳ、Ⅴ）的資料端點。
//
// 為什麼不把整份明細塞進結果頁：全校在結果公告後同時來看，每頁多幾百 KB 就會把
// 服務的記憶體推到 pm2 的重啟門檻（壓力測試量過）。頁面只渲染前幾十筆，
// 要全部的人從這裡下載；要查自己那張票的人用 POST 查單筆。
//
// 單筆查詢一定要走 POST body、不能是 GET 的 ?code=：query string 會留在
// nginx／Cloudflare 的存取記錄與瀏覽器歷史裡，等於把「誰在查哪個代碼」永久留痕。
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
      // D12-3：撞號的無效票要跟「純粹解不開的爛票」分開講，不然投票人查自己的
      // 收據看不出發生了什麼事（見 lib/disclosure.ts 的 markDuplicateCodesInvalid）。
      return entry.reason === "duplicate-code" ? "代碼重複，無效" : "無效票";
  }
}

interface LoadedElection {
  entries: DisclosureEntry[];
  labels: Map<string, string>;
  sealedHash: string | null;
}

async function loadElection(slug: string): Promise<LoadedElection | null> {
  const election = await prisma.election.findFirst({
    where: { slug, hiddenAt: null, status: "published" },
    select: {
      kind: true,
      disclosuresJson: true,
      sealedHash: true,
      candidates: {
        where: { status: "approved" },
        orderBy: { number: "asc" },
        select: { id: true, number: true, members: true },
      },
    },
  });
  if (!election || !Array.isArray(election.disclosuresJson)) return null;
  return {
    entries: election.disclosuresJson as unknown as DisclosureEntry[],
    labels: labelOf(election.kind, election.candidates),
    sealedHash: election.sealedHash,
  };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/elections/[slug]/disclosures">) {
  const { slug } = await ctx.params;
  const loaded = await loadElection(slug);
  if (!loaded) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { entries, labels, sealedHash } = loaded;

  // 內容只由彌封決定，公告後不會再變——用 sealedHash 當 ETag，命中就 304 免序列化。
  const cacheControl = "public, max-age=300, s-maxage=3600";
  const etag = `"${sealedHash ?? "none"}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
  }

  const rows = ["代碼,內容", ...entries.map((e) => `${e.code},"${describe(e, labels).replace(/"/g, '""')}"`)];
  return new NextResponse(`﻿${rows.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="disclosures-${slug}.csv"`,
      "Cache-Control": cacheControl,
      ETag: etag,
    },
  });
}

// 單筆查詢：投票人拿收據來核對自己那一票。POST body 帶 code，不是 query string。
export async function POST(req: NextRequest, ctx: RouteContext<"/api/elections/[slug]/disclosures">) {
  const { slug } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.trim().toLowerCase() : "";
  if (!code) return NextResponse.json({ error: "code required" }, { status: 400 });

  const loaded = await loadElection(slug);
  if (!loaded) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { entries, labels, sealedHash } = loaded;

  // 存在性檢查一定要在條件請求判斷之前：ETag 只由 sealedHash＋code 組成，
  // sealedHash 本身透過 /sealed-box 公開可查，猜一個代碼配上就能拼出合法格式的
  // If-None-Match——先信它就等於讓偽造的快取命中蓋過「這代碼到底存不存在」。
  const found = entries.find((e) => e.code === code);
  if (!found) return NextResponse.json({ found: false }, { status: 404 });

  const cacheControl = "private, max-age=300";
  const etag = `"${sealedHash ?? "none"}-${code}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
  }
  return NextResponse.json(
    { found: true, code: found.code, summary: describe(found, labels) },
    { headers: { "Cache-Control": cacheControl, ETag: etag } },
  );
}

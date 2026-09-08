// 結果頁：status=published 才顯示完整結果，否則顯示「結果尚未公布」。
// 依 §26-1 Ⅴ，這裡同時是第三份公告的附刊：去識別化選票明細（全體可見）與
// 投票暨未投票選舉人名冊（登入會員可見）。原始密文不下發，只提供彌封快照下載端點。
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Trophy, ShieldCheck, Download } from "lucide-react";
import { PublicShell } from "@/components/public/Shell";
import { StatusBadge } from "@/components/public/Badges";
import { CopyLinkButton } from "@/components/public/CopyLinkButton";
import { ReceiptLookup } from "@/components/public/ReceiptLookup";
import { DisclosureTable } from "@/components/public/DisclosureTable";
import { RosterDisclosure, type RosterRow } from "@/components/public/RosterDisclosure";
import { Card, cn } from "tpass-ui";
import { tpass, authConfig, loginUrlFor } from "@/config/auth";
import { isAdmin } from "@/config/admin";
import { prisma } from "@/lib/db";
import type { DisclosureEntry } from "@/lib/disclosure";
import type { TallyResult } from "@/lib/tally";
import { recallPassed } from "@/lib/recall";
import { KIND_LABEL, candidateDisplayName, formatDateTime } from "@/components/public/shared";

// 明細與名冊在頁面上只列這麼多筆，其餘走 CSV 下載端點。
// 這個數字直接決定結果頁的大小上限——調大之前先跑 pnpm stress。
const PREVIEW_ROWS = 50;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const election = await prisma.election.findFirst({
    where: { slug, hiddenAt: null },
    select: { title: true },
  });
  if (!election) return { title: "找不到選舉" };
  return { title: `開票結果｜${election.title}`, description: "T-Vote 開票結果" };
}

export default async function ResultsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await tpass.getSession();
  // 明確 select：**絕對不要把 sealedBox 撈進來**。它是整個票匭的密文（每張票約 3.2 KB——
  // 選票加了定長填充消除長度側通道之後，比舊格式大約 5 倍），
  // 這一頁只需要張數，而張數在 resultsJson 裡。撈了它會讓每個請求多吃幾百 KB，
  // 結果公告後全校同時來看時直接把記憶體推到 pm2 的重啟門檻——壓力測試量過。
  // 要驗算票匭的人走 /api/elections/[slug]/sealed-box 下載。
  const election = await prisma.election.findFirst({
    where: { slug, hiddenAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      kind: true,
      status: true,
      seats: true,
      resultsJson: true,
      disclosuresJson: true,
      sealedHash: true,
      sealedAt: true,
      candidates: {
        where: { status: "approved" },
        orderBy: { number: "asc" },
        select: { id: true, number: true, members: true },
      },
    },
  });
  if (!election || election.status === "draft") notFound();

  const admin = isAdmin(session);
  const shareUrl = new URL(`/e/${slug}/results`, authConfig.selfUrl).toString();

  if (election.status !== "published") {
    return (
      <PublicShell isLoggedIn={session !== null} isAdmin={admin}>
        <Link href={`/e/${slug}`} className="text-sm font-bold text-accent hover:underline">
          ← {election.title}
        </Link>
        <h1 className="mt-3 font-extrabold text-2xl">開票結果</h1>
        <div className="mt-2">
          <StatusBadge status={election.status} />
        </div>
        <Card className="mt-6 text-center">
          <p className="font-bold">結果尚未公布</p>
          <p className="mt-1 text-sm font-medium text-muted-foreground">
            選委會彌封並完成開票、公布結果公告後，這裡才會顯示完整結果。
          </p>
        </Card>
      </PublicShell>
    );
  }

  const results = election.resultsJson as unknown as TallyResult | null;
  const disclosures = (election.disclosuresJson as unknown as DisclosureEntry[] | null) ?? [];
  // 票匭張數取自已提交的計票結果——submitResults 驗過它等於 sealedBox 長度。
  const ballotCount = results?.totalBallots ?? 0;

  const candidateById = new Map(election.candidates.map((c) => [c.id, c]));
  // 明細表用的「id → 顯示名稱」對照：號次在前，方便對照選票。
  const candidateLabels = Object.fromEntries(
    election.candidates.map((c) => [
      c.id,
      `${c.number !== null ? `${c.number} 號・` : ""}${candidateDisplayName(
        election.kind,
        c.members as unknown as { name: string; email: string; grade: string }[],
      )}`,
    ]),
  );

  // §26-1 Ⅴ 的名冊：只給登入會員看，未登入者只看得到統計數字。
  // 頁面只撈前 PREVIEW_ROWS 筆——完整名冊走 /api/elections/[slug]/roster 下載。
  // 全撈會讓每個請求的記憶體與 HTML 隨選舉人數線性成長，公告後的併發尖峰扛不住。
  const roster: { preview: RosterRow[]; total: number; votedCount: number } | null =
    session === null
      ? null
      : await (async () => {
          const [rows, total, votedCount] = await Promise.all([
            prisma.voter.findMany({
              where: { electionId: election.id },
              select: { name: true, email: true, hasVoted: true },
              orderBy: [{ name: "asc" }, { email: "asc" }],
              take: PREVIEW_ROWS,
            }),
            prisma.voter.count({ where: { electionId: election.id } }),
            prisma.voter.count({ where: { electionId: election.id, hasVoted: true } }),
          ]);
          return {
            preview: rows.map((v) => ({
              label: v.name?.trim() || v.email.split("@")[0],
              voted: v.hasVoted,
            })),
            total,
            votedCount,
          };
        })();
  const isRecall = election.kind === "recall";
  const recallTarget = results?.candidates[0];
  const recallResultPassed = recallTarget ? recallPassed(recallTarget.votes, recallTarget.disagree) : false;

  return (
    <PublicShell isLoggedIn={session !== null} isAdmin={admin}>
      <Link href={`/e/${slug}`} className="text-sm font-bold text-accent hover:underline">
        ← {election.title}
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusBadge status={election.status} />
        <span className="font-mono text-[11px] font-bold text-muted-foreground">
          {KIND_LABEL[election.kind] ?? election.kind}
        </span>
      </div>
      <h1 className="mt-1 font-extrabold text-2xl sm:text-3xl">開票結果</h1>
      <div className="mt-3">
        <CopyLinkButton url={shareUrl} label="複製本頁連結" />
      </div>

      {!results ? (
        <Card className="mt-6 text-center">
          <p className="font-bold">結果資料缺漏，請聯絡選委會</p>
        </Card>
      ) : (
        <>
          <Card className="mt-6">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <Stat label="投票率" value={`${results.turnoutPct}%`} />
              <Stat label="有效票" value={String(results.validCount)} />
              <Stat label="廢票" value={String(results.blankCount)} />
              <Stat label="無效票" value={String(results.invalidCount)} />
            </div>
            <p className="mt-3 text-center text-sm font-medium text-muted-foreground">
              名冊 {results.rosterCount} 人・票匭共 {results.totalBallots} 張
            </p>
            {results.hasTie && (
              <p className="mt-2 rounded-xl border-2 border-destructive bg-card px-3 py-2 text-center text-sm font-bold text-destructive">
                席次邊界出現同票，待選委會處理（抽籤或重選）
              </p>
            )}
            {isRecall && recallTarget && (
              <p
                className={cn(
                  "mt-2 rounded-xl border-2 px-3 py-2 text-center text-sm font-bold",
                  recallResultPassed
                    ? "border-foreground bg-tone-green-badge text-tone-green-text"
                    : "border-destructive bg-card text-destructive",
                )}
              >
                罷免案{recallResultPassed ? "通過" : "否決"}
              </p>
            )}
          </Card>

          <section className="mt-6">
            <h2 className="flex items-center gap-2 font-extrabold text-base">
              <Trophy className="h-4 w-4" /> {isRecall ? "罷免結果" : "各候選人結果"}
            </h2>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {results.candidates.map((ct) => {
                const candidate = candidateById.get(ct.candidateId);
                const name = candidate
                  ? candidateDisplayName(
                      election.kind,
                      candidate.members as unknown as {
                        name: string;
                        email: string;
                        grade: string;
                      }[],
                    )
                  : ct.candidateId;
                return (
                  <div
                    key={ct.candidateId}
                    className={cn(
                      "rounded-2xl border-2 border-foreground bg-card p-4 shadow-[4px_4px_0_0_var(--color-foreground)]",
                      ct.tied && "border-destructive",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        {candidate?.number !== null && candidate?.number !== undefined && (
                          <span className="font-mono text-[11px] font-bold text-muted-foreground">
                            {candidate.number} 號
                          </span>
                        )}
                        <h3 className="font-extrabold">
                          {isRecall ? "罷免對象：" : ""}
                          {name}
                        </h3>
                      </div>
                      {isRecall ? (
                        <span
                          className={cn(
                            "rounded-md border-2 px-2 py-0.5 font-mono text-[11px] font-bold",
                            recallPassed(ct.votes, ct.disagree)
                              ? "border-foreground bg-tone-green-badge text-tone-green-text"
                              : "border-destructive bg-card text-destructive",
                          )}
                        >
                          {recallPassed(ct.votes, ct.disagree) ? "通過" : "否決"}
                        </span>
                      ) : (
                        ct.elected && (
                          <span className="rounded-md border-2 border-foreground bg-tone-green-badge px-2 py-0.5 font-mono text-[11px] font-bold text-tone-green-text">
                            當選
                          </span>
                        )
                      )}
                      {ct.tied && (
                        <span className="rounded-md border-2 border-destructive bg-card px-2 py-0.5 font-mono text-[11px] font-bold text-destructive">
                          同票待處理
                        </span>
                      )}
                    </div>
                    {results.mode === "choose" ? (
                      <p className="mt-2 font-bold">{ct.votes} 票</p>
                    ) : isRecall ? (
                      <p className="mt-2 font-bold">
                        同意罷免 {ct.votes}・不同意罷免 {ct.disagree}
                      </p>
                    ) : (
                      <p className="mt-2 font-bold">
                        同意 {ct.votes}・不同意 {ct.disagree}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mt-6">
            <ReceiptLookup slug={slug} />
          </section>

          {disclosures.length > 0 && (
            <section className="mt-6">
              <DisclosureTable
                slug={slug}
                preview={disclosures.slice(0, PREVIEW_ROWS)}
                total={disclosures.length}
                candidateLabels={candidateLabels}
              />
            </section>
          )}

          <section className="mt-6">
            {roster ? (
              <RosterDisclosure
                slug={slug}
                preview={roster.preview}
                total={roster.total}
                votedCount={roster.votedCount}
              />
            ) : (
              <Card>
                <h2 className="font-extrabold text-base">投票暨未投票選舉人名冊</h2>
                <p className="mt-1 text-sm font-medium text-muted-foreground">
                  依選罷法 §26-1 Ⅴ 附刊，登入後可查看。
                </p>
                <Link
                  href={loginUrlFor(`/e/${slug}/results`)}
                  className="mt-3 inline-block font-bold text-sm text-accent hover:underline"
                >
                  以學校帳號登入
                </Link>
              </Card>
            )}
          </section>

          <section className="mt-6">
            <h2 className="flex items-center gap-2 font-extrabold text-base">
              <ShieldCheck className="h-4 w-4" /> 彌封資訊
            </h2>
            <Card className="mt-3">
              <p className="text-sm font-medium">
                票匭張數：<span className="font-mono font-bold">{ballotCount}</span> 張・彌封於{" "}
                {formatDateTime(election.sealedAt)}
              </p>
              <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                sealedHash：{election.sealedHash}
              </p>
              <p className="mt-2 text-sm font-medium text-muted-foreground">
                任何持有開票私鑰者皆可下載彌封快照，重新驗算本次開票結果。
              </p>
              <a
                href={`/api/elections/${slug}/sealed-box`}
                className="mt-3 inline-flex items-center gap-1.5 rounded-xl border-2 border-foreground bg-card px-3 py-1.5 font-bold text-sm shadow-[3px_3px_0_0_var(--color-foreground)]"
              >
                <Download className="h-4 w-4" /> 下載彌封快照
              </a>
            </Card>
          </section>
        </>
      )}
    </PublicShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-extrabold text-2xl">{value}</p>
      <p className="font-mono text-[11px] font-bold text-muted-foreground">{label}</p>
    </div>
  );
}

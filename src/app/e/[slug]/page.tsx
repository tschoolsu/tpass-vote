// 選舉詳情頁：狀態、時程倒數、核准候選人卡片、已發布公告連結、依狀態 CTA。
// 不強制登入（同 tpass-form 的公開頁模式）：任何人可看，登記／投票才需要登入。
import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarClock, Megaphone } from "lucide-react";
import { PublicShell } from "@/components/public/Shell";
import { StatusBadge } from "@/components/public/Badges";
import { CandidateCard } from "@/components/public/CandidateCard";
import { CopyLinkButton } from "@/components/public/CopyLinkButton";
import { LinkButton } from "@/components/public/LinkButton";
import { Markdown } from "@/components/public/Markdown";
import { RecallSignaturePanel, type RecallRosterState } from "@/components/public/RecallSignaturePanel";
import { Card } from "tpass-ui";
import { tpass, authConfig, loginUrlFor } from "@/config/auth";
import { isAdmin } from "@/config/admin";
import { prisma } from "@/lib/db";
import { recallThreshold } from "@/lib/recall";
import {
  LEGAL_TAG_LABEL,
  KIND_LABEL,
  STATUS_LABEL,
  LINEAGE_LABEL,
  describeRemaining,
  formatDateTime,
  candidateDisplayName,
  type MemberInfo,
} from "@/components/public/shared";

// cache()：generateMetadata 與頁面本體都會呼叫這裡，同一次請求只查一次 Election。
// 明確 select：**不要把 sealedBox／resultsJson／disclosuresJson 撈進來**——這頁不需要
// 票匭內容，撈了它們會讓公告後全校同時來看時，每個請求多背幾百 KB～幾 MB（見 D8 稽核）。
const getElection = cache(async (slug: string) => {
  return prisma.election.findFirst({
    where: { slug, hiddenAt: null },
    select: {
      id: true,
      status: true,
      kind: true,
      title: true,
      lineage: true,
      parentId: true,
      registrationStartsAt: true,
      registrationEndsAt: true,
      votingStartsAt: true,
      votingEndsAt: true,
      recallReason: true,
      recallDefense: true,
      recallLeadName: true,
      recallTargetCandidateId: true,
      recallTargetOfficeId: true,
      candidates: {
        where: { status: "approved" },
        orderBy: { number: "asc" },
        select: { id: true, number: true, members: true, platform: true },
      },
      announcements: {
        orderBy: { publishedAt: "desc" },
        select: { id: true, publishedAt: true, legalTag: true, title: true },
      },
    },
  });
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const election = await getElection(slug);
  if (!election || election.status === "draft") return { title: "找不到選舉" };
  return {
    title: `${election.title}｜T-Vote`,
    description: `${STATUS_LABEL[election.status] ?? election.status}・${KIND_LABEL[election.kind] ?? election.kind}`,
  };
}

export default async function ElectionDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await tpass.getSession();
  const election = await getElection(slug);
  if (!election || election.status === "draft") notFound();

  const admin = isAdmin(session);
  const now = new Date();
  const shareUrl = new URL(`/e/${slug}`, authConfig.selfUrl).toString();

  const publishedAnnouncements = election.announcements.filter((a) => a.publishedAt !== null);

  const isRecall = election.kind === "recall";

  // 罷免案專屬資料：對象、原選舉連結、連署進度、目前登入者的連署狀態（三態）。
  // 這裡的 rosterState 只決定畫面初始呈現，不是安全邊界——真正擋人的是 server action 自己。
  let recallTarget: { members: MemberInfo[] } | null = null;
  let recallParent: { slug: string; title: string } | null = null;
  let recallCount = 0;
  let recallThresholdCount = 0;
  let recallRosterState: RecallRosterState = "not_logged_in";

  if (isRecall) {
    const target =
      election.candidates.find((c) => c.id === election.recallTargetCandidateId) ??
      election.candidates[0] ??
      null;
    if (target) recallTarget = { members: target.members as unknown as MemberInfo[] };

    // 門檻母數＝罷免對象職務落地時的「當屆有效票」快照（Office.termValidCount）。
    if (election.recallTargetOfficeId) {
      const office = await prisma.office.findUnique({
        where: { id: election.recallTargetOfficeId },
        select: { termValidCount: true },
      });
      if (office?.termValidCount != null) recallThresholdCount = recallThreshold(office.termValidCount);
    }

    if (election.parentId) {
      const parent = await prisma.election.findUnique({
        where: { id: election.parentId },
        select: { slug: true, title: true },
      });
      if (parent) recallParent = { slug: parent.slug, title: parent.title };
    }

    recallCount = await prisma.recallSignature.count({ where: { electionId: election.id } });

    // 連署開放全校：登入即可連署，只看是否已署（不查選區名冊）。
    // 這頁本身不登入也能看，走的是 tpass.getSession() 而非 guard.ts 的
    // requireSession()，吃不到那邊的正規化，所以這裡的查詢要自己正規化一次，
    // 否則跟 signRecall/withdrawSignature（都經 requireSession）用不同的
    // signerEmail 大小寫去比對，會出現「明明連署了卻顯示未連署」的不一致。
    if (session) {
      const signature = await prisma.recallSignature.findUnique({
        where: {
          electionId_signerEmail: {
            electionId: election.id,
            signerEmail: session.email.trim().toLowerCase(),
          },
        },
      });
      recallRosterState = signature ? "signed" : "not_signed";
    }
  }

  const timelineAll: { label: string; date: Date | null; countdown: string | null }[] = [
    {
      label: "登記開始",
      date: election.registrationStartsAt,
      countdown:
        election.status === "campaigning" || election.status === "draft"
          ? null
          : election.registrationStartsAt && now < election.registrationStartsAt
            ? describeRemaining(election.registrationStartsAt, now)
            : null,
    },
    {
      label: "登記截止",
      date: election.registrationEndsAt,
      countdown:
        election.status === "registration"
          ? describeRemaining(election.registrationEndsAt, now)
          : null,
    },
    {
      label: "投票開始",
      date: election.votingStartsAt,
      countdown:
        election.status === "campaigning"
          ? describeRemaining(election.votingStartsAt, now)
          : null,
    },
    {
      label: "投票截止",
      date: election.votingEndsAt,
      countdown:
        election.status === "voting" ? describeRemaining(election.votingEndsAt, now) : null,
    },
  ];

  // 罷免場次沒有登記/政見階段（see lib/election-status），登記相關兩列永遠是「未定」，
  // 對使用者沒有資訊量，只留投票開始/截止。
  const timeline = isRecall
    ? timelineAll.filter((t) => t.label === "投票開始" || t.label === "投票截止")
    : timelineAll;

  return (
    <PublicShell isLoggedIn={session !== null} isAdmin={admin}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={election.status} />
        <span className="font-mono text-[11px] font-bold text-muted-foreground">
          {KIND_LABEL[election.kind] ?? election.kind}
        </span>
        {!isRecall && election.parentId && (
          <span className="font-mono text-[11px] font-bold text-tone-orange-text">
            {LINEAGE_LABEL[election.lineage ?? ""] ?? "重選場次"}
          </span>
        )}
      </div>

      <h1 className="mt-3 font-extrabold text-2xl sm:text-3xl tracking-tight">{election.title}</h1>

      {isRecall && (
        <p className="mt-2 text-sm font-medium text-muted-foreground">
          罷免對象：
          <span className="font-bold text-foreground">
            {recallTarget ? candidateDisplayName("recall", recallTarget.members) : "（未填）"}
          </span>
          {recallParent && (
            <>
              {" "}
              ・原選舉：
              <Link
                href={`/e/${recallParent.slug}`}
                className="font-bold text-accent hover:underline"
              >
                {recallParent.title}
              </Link>
            </>
          )}
          {election.recallLeadName && (
            <>
              {" "}
              ・發起人：<span className="font-bold text-foreground">{election.recallLeadName}</span>
            </>
          )}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <CTA status={election.status} slug={slug} />
        <CopyLinkButton url={shareUrl} label="複製本頁連結" />
      </div>

      {isRecall && (
        <Card className="mt-6">
          <h2 className="font-extrabold text-base">罷免事由</h2>
          <div className="mt-3 text-sm">
            <Markdown text={election.recallReason || "（未填寫）"} />
          </div>
        </Card>
      )}

      {isRecall && election.recallDefense && (
        <Card className="mt-6">
          <h2 className="font-extrabold text-base">答辯書</h2>
          <div className="mt-3 text-sm">
            <Markdown text={election.recallDefense} />
          </div>
        </Card>
      )}

      {isRecall && (
        <Card className="mt-6">
          <RecallSignaturePanel
            slug={slug}
            status={election.status}
            loginUrl={loginUrlFor(`/e/${slug}`)}
            rosterState={recallRosterState}
            initialCount={recallCount}
            threshold={recallThresholdCount}
          />
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="flex items-center gap-2 font-extrabold text-base">
          <CalendarClock className="h-4 w-4" /> 時程
        </h2>
        <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {timeline.map((t) => (
            <div key={t.label} className="rounded-xl border-2 border-foreground/15 p-3">
              <dt className="font-mono text-[11px] font-bold text-muted-foreground">{t.label}</dt>
              <dd className="mt-1 font-bold">{formatDateTime(t.date)}</dd>
              {t.countdown && (
                <dd className="mt-0.5 text-sm font-medium text-accent">{t.countdown}</dd>
              )}
            </div>
          ))}
        </dl>
      </Card>

      {!isRecall && (
        <section className="mt-6">
          <h2 className="font-extrabold text-base">
            核准候選人{election.candidates.length > 0 ? `（${election.candidates.length}）` : ""}
          </h2>
          {election.candidates.length === 0 ? (
            <p className="mt-2 text-sm font-medium text-muted-foreground">
              尚無核准候選人名單。
            </p>
          ) : (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {election.candidates.map((c) => (
                <CandidateCard
                  key={c.id}
                  kind={election.kind}
                  candidate={{
                    id: c.id,
                    number: c.number,
                    members: c.members as unknown as MemberInfo[],
                    platform: c.platform,
                  }}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {publishedAnnouncements.length > 0 && (
        <section className="mt-6">
          <h2 className="flex items-center gap-2 font-extrabold text-base">
            <Megaphone className="h-4 w-4" /> 公告
          </h2>
          <div className="mt-3 flex flex-col gap-2">
            {publishedAnnouncements.map((a) => (
              <Link
                key={a.id}
                href={`/e/${slug}/a/${a.id}`}
                className="flex items-center justify-between rounded-xl border-2 border-foreground bg-card px-4 py-3 font-bold shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-foreground)]"
              >
                <span>
                  {a.legalTag && <>{LEGAL_TAG_LABEL[a.legalTag] ?? a.legalTag}：</>}
                  {a.title}
                </span>
                <span className="font-mono text-[11px] font-normal text-muted-foreground">
                  {formatDateTime(a.publishedAt)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </PublicShell>
  );
}

function CTA({ status, slug }: { status: string; slug: string }) {
  if (status === "registration") {
    return (
      <LinkButton href={`/e/${slug}/register`} variant="primary">
        登記候選人
      </LinkButton>
    );
  }
  if (status === "voting") {
    return (
      <LinkButton href={`/e/${slug}/vote`} variant="primary">
        前往投票
      </LinkButton>
    );
  }
  if (status === "published") {
    return (
      <LinkButton href={`/e/${slug}/results`} variant="accent">
        查看結果
      </LinkButton>
    );
  }
  return null;
}

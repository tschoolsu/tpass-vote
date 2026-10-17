// 候選人個別頁：給候選人（和支持者）分享出去用。
// 連結預覽圖由同層 opengraph-image.tsx 產生，IG 限動圖由 story/route.tsx 產生。
// 不強制登入，公開範圍跟選舉詳情頁一致（見 lib/public-candidate.ts）。
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { Card } from "tpass-ui";
import { PublicShell } from "@/components/public/Shell";
import { StatusBadge } from "@/components/public/Badges";
import { CandidateCard } from "@/components/public/CandidateCard";
import { CopyLinkButton } from "@/components/public/CopyLinkButton";
import { LinkButton } from "@/components/public/LinkButton";
import { tpass, authConfig } from "@/config/auth";
import { isAdmin } from "@/config/admin";
import { candidatePageUrl, findPublicCandidate } from "@/lib/public-candidate";
import { candidateDisplayName, plainExcerpt } from "@/components/public/shared";

type Params = Promise<{ slug: string; number: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, number } = await params;
  const data = await findPublicCandidate(slug, number);
  if (!data) return { title: "找不到候選人" };
  const { election, candidate } = data;
  const name = candidateDisplayName(election.kind, candidate.members);
  return {
    // og:image 由 opengraph-image.tsx 自動掛上；它要絕對網址，所以這裡給 metadataBase。
    metadataBase: new URL(authConfig.selfUrl),
    title: `${candidate.number} 號 ${name}｜${election.title}`,
    description: plainExcerpt(candidate.platform),
  };
}

export default async function CandidatePage({ params }: { params: Params }) {
  const { slug, number } = await params;
  const session = await tpass.getSession();
  const data = await findPublicCandidate(slug, number);
  if (!data) notFound();
  const { election, candidate } = data;

  return (
    <PublicShell isLoggedIn={session !== null} isAdmin={isAdmin(session)}>
      <Link
        href={`/e/${slug}`}
        className="inline-flex items-center gap-1.5 text-sm font-bold text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {election.title}
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusBadge status={election.status} />
      </div>

      <div className="mt-4">
        <CandidateCard kind={election.kind} candidate={candidate} expanded />
      </div>

      {election.status === "voting" && (
        <div className="mt-4">
          <LinkButton href={`/e/${slug}/vote`} variant="primary">
            前往投票
          </LinkButton>
        </div>
      )}

      <Card className="mt-6">
        <h2 className="font-extrabold text-base">分享</h2>
        <p className="mt-1 text-sm font-medium text-muted-foreground">
          連結貼到 LINE、Discord 會自動出現預覽卡；IG 限動請下載直式圖再上傳，圖上附 QR code 連回這頁。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <LinkButton
            href={`/e/${slug}/c/${candidate.number}/story`}
            download={`${election.title}-${candidate.number}號.png`}
            variant="primary"
          >
            <Download className="h-4 w-4" /> 下載限動圖
          </LinkButton>
          <CopyLinkButton url={candidatePageUrl(slug, candidate.number)} label="複製本頁連結" />
        </div>
      </Card>
    </PublicShell>
  );
}

// 公告獨立頁（kind ∈ first/second/result）。未發布（草稿或不存在）一律 404。
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicShell } from "@/components/public/Shell";
import { CopyLinkButton } from "@/components/public/CopyLinkButton";
import { Markdown } from "@/components/public/Markdown";
import { getSession } from "@/lib/tpass-auth";
import { isAdmin } from "@/config/admin";
import { authConfig } from "@/config/auth";
import { prisma } from "@/lib/db";
import {
  ANNOUNCEMENT_KIND_LABEL,
  formatDateTime,
  isAnnouncementKind,
  plainExcerpt,
} from "@/components/public/shared";

async function getAnnouncement(slug: string, kind: string) {
  if (!isAnnouncementKind(kind)) return null;
  const election = await prisma.election.findUnique({
    where: { slug },
    select: { id: true, title: true, status: true },
  });
  if (!election) return null;
  const announcement = await prisma.announcement.findUnique({
    where: { electionId_kind: { electionId: election.id, kind } },
  });
  if (!announcement || !announcement.publishedAt) return null;
  return { election, announcement };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; kind: string }>;
}): Promise<Metadata> {
  const { slug, kind } = await params;
  const found = await getAnnouncement(slug, kind);
  if (!found) return { title: "找不到公告" };
  return {
    title: `${found.election.title}｜${ANNOUNCEMENT_KIND_LABEL[found.announcement.kind]}`,
    description: plainExcerpt(found.announcement.body),
  };
}

export default async function AnnouncementPage({
  params,
}: {
  params: Promise<{ slug: string; kind: string }>;
}) {
  const { slug, kind } = await params;
  const session = await getSession();
  const found = await getAnnouncement(slug, kind);
  if (!found) notFound();

  const { election, announcement } = found;
  const admin = session ? await isAdmin(session.email) : false;
  const shareUrl = new URL(`/e/${slug}/a/${kind}`, authConfig.selfUrl).toString();

  return (
    <PublicShell isLoggedIn={session !== null} isAdmin={admin}>
      <Link href={`/e/${slug}`} className="text-sm font-bold text-accent hover:underline">
        ← {election.title}
      </Link>

      <p className="mt-3 font-mono text-[11px] font-bold text-muted-foreground">
        {ANNOUNCEMENT_KIND_LABEL[announcement.kind] ?? announcement.kind}・
        {formatDateTime(announcement.publishedAt)} 發布
      </p>
      <h1 className="mt-1 font-extrabold text-2xl sm:text-3xl tracking-tight">
        {announcement.title}
      </h1>

      <div className="mt-4">
        <CopyLinkButton url={shareUrl} label="複製本頁連結" />
      </div>

      <div className="mt-6 rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)]">
        <Markdown text={announcement.body} />
      </div>
    </PublicShell>
  );
}

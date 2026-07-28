// 公告獨立頁（依 announcement id 讀取，非 legalTag）。未發布（草稿或不存在，或不屬於這個
// slug 底下的選舉）一律 404。OG meta 用該則自己的 title，每則獨立。
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
import { LEGAL_TAG_LABEL, formatDateTime, plainExcerpt } from "@/components/public/shared";

async function getAnnouncement(slug: string, id: string) {
  const election = await prisma.election.findFirst({
    where: { slug, hiddenAt: null },
    select: { id: true, title: true, status: true },
  });
  if (!election) return null;
  const announcement = await prisma.announcement.findUnique({ where: { id } });
  if (!announcement || announcement.electionId !== election.id) return null;
  if (!announcement.publishedAt) return null;
  return { election, announcement };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}): Promise<Metadata> {
  const { slug, id } = await params;
  const found = await getAnnouncement(slug, id);
  if (!found) return { title: "找不到公告" };
  return {
    title: `${found.election.title}｜${found.announcement.title}`,
    description: plainExcerpt(found.announcement.body),
  };
}

export default async function AnnouncementPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const session = await getSession();
  const found = await getAnnouncement(slug, id);
  if (!found) notFound();

  const { election, announcement } = found;
  const admin = isAdmin(session);
  const shareUrl = new URL(`/e/${slug}/a/${id}`, authConfig.selfUrl).toString();
  const tagLabel = announcement.legalTag ? LEGAL_TAG_LABEL[announcement.legalTag] ?? announcement.legalTag : null;

  return (
    <PublicShell isLoggedIn={session !== null} isAdmin={admin}>
      <Link href={`/e/${slug}`} className="text-sm font-bold text-accent hover:underline">
        ← {election.title}
      </Link>

      <p className="mt-3 font-mono text-[11px] font-bold text-muted-foreground">
        {tagLabel && <>{tagLabel}・</>}
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

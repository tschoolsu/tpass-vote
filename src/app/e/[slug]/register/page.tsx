// 候選人登記頁：需登入。status=registration 才開放送出；已登記者顯示狀態，needs_fix 可編輯重送。
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { User } from "lucide-react";
import { PublicShell } from "@/components/public/Shell";
import { CandidateStatusBadge } from "@/components/public/Badges";
import { RegisterForm } from "@/components/public/RegisterForm";
import { Markdown } from "@/components/public/Markdown";
import { Card } from "tpass-ui";
import { requireSession } from "@/lib/guard";
import { isAdmin } from "@/config/admin";
import { prisma } from "@/lib/db";
import {
  CANDIDATE_STATUS_LABEL,
  KIND_LABEL,
  formatDateTime,
  type MemberInfo,
} from "@/components/public/shared";

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
  return { title: `候選人登記｜${election.title}`, description: "T-Vote 候選人登記" };
}

export default async function RegisterPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession(`/e/${slug}/register`);
  const election = await prisma.election.findFirst({ where: { slug, hiddenAt: null } });
  if (!election || election.status === "draft") notFound();

  const admin = isAdmin(session);

  const existing = await prisma.candidate.findFirst({
    where: { electionId: election.id, createdBy: session.email },
    orderBy: { createdAt: "desc" },
  });

  const existingAttachments = existing
    ? await prisma.upload.findMany({
        where: { id: { in: (existing.attachments as string[] | null) ?? [] } },
        select: { id: true, filename: true },
      })
    : [];

  const blocking =
    existing && existing.status !== "rejected" && existing.status !== "withdrawn" ? existing : null;
  const editable = existing && existing.status === "needs_fix" ? existing : null;
  const canSubmitFresh = !blocking;

  return (
    <PublicShell isLoggedIn isAdmin={admin}>
      <Link href={`/e/${slug}`} className="text-sm font-bold text-accent hover:underline">
        ← {election.title}
      </Link>
      <h1 className="mt-3 font-extrabold text-2xl sm:text-3xl tracking-tight">候選人登記</h1>
      <p className="mt-1 font-medium text-muted-foreground">
        {KIND_LABEL[election.kind] ?? election.kind}
        {election.kind === "leader" && "・請填寫候選人與副手兩組資料"}
      </p>

      {existing && (
        <Card className="mt-6">
          <div className="flex items-center justify-between">
            <span className="font-bold">你的登記狀態</span>
            <CandidateStatusBadge status={existing.status} />
          </div>
          <p className="mt-2 text-sm font-medium text-muted-foreground">
            送出於 {formatDateTime(existing.createdAt)}
            {existing.updatedAt.getTime() !== existing.createdAt.getTime() &&
              `・更新於 ${formatDateTime(existing.updatedAt)}`}
          </p>
          {existing.reviewNote && (
            <p className="mt-2 rounded-xl border-2 border-foreground/20 bg-muted p-3 text-sm font-medium">
              審核意見：{existing.reviewNote}
            </p>
          )}
          {!editable && existing.status !== "rejected" && existing.status !== "withdrawn" && (
            <p className="mt-2 text-sm font-medium text-muted-foreground">
              目前狀態為「{CANDIDATE_STATUS_LABEL[existing.status] ?? existing.status}」，如需修改請聯絡選委會。
            </p>
          )}
        </Card>
      )}

      {existing && (
        <Card className="mt-6">
          <p className="font-bold">你送出的登記內容</p>
          <div className="mt-3 flex flex-wrap gap-4">
            {(existing.members as unknown as MemberInfo[]).map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-foreground bg-muted">
                  {m.photo ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 相片來自我方 /api/photos，非外部來源，不需要 next/image 的最佳化。
                    <img
                      src={`/api/photos/${m.photo}`}
                      alt={`${m.name}大頭照`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <User className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div>
                  <p className="font-bold text-sm">{m.name}</p>
                  <p className="text-xs font-medium text-muted-foreground">{m.grade}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t-2 border-foreground/10 pt-3">
            <p className="font-bold text-accent text-sm">政見</p>
            <div className="mt-1.5 text-sm text-foreground/80">
              <Markdown text={existing.platform} />
            </div>
          </div>
        </Card>
      )}

      {election.status !== "registration" ? (
        <Card className="mt-6 text-center">
          <p className="font-bold">目前非候選人登記期間</p>
          <p className="mt-1 text-sm font-medium text-muted-foreground">
            登記僅開放於「{formatDateTime(election.registrationStartsAt)} ～{" "}
            {formatDateTime(election.registrationEndsAt)}」。
          </p>
        </Card>
      ) : (
        (canSubmitFresh || editable) && (
          <div className="mt-6">
            <RegisterForm
              slug={slug}
              electionId={election.id}
              kind={election.kind}
              initial={
                editable
                  ? {
                      members: editable.members as unknown as MemberInfo[],
                      platform: editable.platform,
                      attachments: existingAttachments,
                    }
                  : undefined
              }
            />
          </div>
        )
      )}
    </PublicShell>
  );
}

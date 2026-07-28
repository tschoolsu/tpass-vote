// 發起罷免頁：server 端算好三個硬條件切畫面（從缺／就職未滿 2 個月／已有進行中連署案），
// 可發起時才顯示表單。免登入可看頁面本身，送出（initiateRecall）時才 requireSession。
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ShieldAlert, Clock, Users2 } from "lucide-react";
import { PublicShell } from "@/components/public/Shell";
import { Card, Button } from "@/components/ui/primitives";
import { InitiateRecallForm } from "@/components/public/InitiateRecallForm";
import { getSession } from "@/lib/tpass-auth";
import { isAdmin } from "@/config/admin";
import { loginUrlFor } from "@/config/auth";
import { prisma } from "@/lib/db";
import { canInitiateRecall, recallEligibleFrom } from "@/lib/recall";
import { formatDateTime } from "@/components/public/shared";

export const metadata: Metadata = { title: "發起罷免｜T-Vote" };

interface Member {
  name: string;
  grade?: string;
}

function memberLabel(v: unknown): string {
  if (!Array.isArray(v)) return "（未填）";
  return v.map((m) => (m as Member)?.name).filter(Boolean).join("、") || "（未填）";
}

export default async function InitiateRecallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const admin = isAdmin(session);

  const office = await prisma.office.findUnique({ where: { id } });
  if (!office) notFound();

  const eligible = !office.isVacant && canInitiateRecall(office.startedAt, new Date());
  const existing = office.isVacant
    ? null
    : await prisma.election.findFirst({
        where: { recallTargetOfficeId: id, kind: "recall", status: "petition", hiddenAt: null },
        select: { slug: true },
      });

  return (
    <PublicShell isLoggedIn={session !== null} isAdmin={admin}>
      <Link href="/offices" className="mb-4 inline-flex items-center gap-1 text-sm font-bold text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> 現任職務
      </Link>

      <div className="flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-destructive" />
        <h1 className="font-extrabold text-2xl tracking-tight">發起罷免</h1>
      </div>
      <p className="mt-2 text-sm font-medium text-muted-foreground">
        罷免對象：<span className="font-bold text-foreground">{office.title}</span>
        （{memberLabel(office.currentMembers)}）
      </p>

      <div className="mt-6">
        {office.isVacant ? (
          <Blocked icon={<Users2 className="h-5 w-5" />} title="此職務目前從缺" body="無現任者，無法發起罷免。" />
        ) : existing ? (
          <Card>
            <p className="font-extrabold">此職務已有進行中的罷免連署</p>
            <p className="mt-1 text-sm font-medium text-muted-foreground">直接前往連署即可，不需重複發起。</p>
            <Link href={`/e/${existing.slug}`} className="mt-3 inline-block">
              <Button variant="primary" size="sm">前往連署</Button>
            </Link>
          </Card>
        ) : !eligible ? (
          <Blocked
            icon={<Clock className="h-5 w-5" />}
            title="就職未滿 2 個月，尚不得提起罷免"
            body={
              office.startedAt
                ? `依規定，需就職滿 2 個月後才能提起。最早可提起日期：${formatDateTime(recallEligibleFrom(office.startedAt))}。`
                : "此職務尚無就職日期，無法判定罷免時機，請洽選委會。"
            }
          />
        ) : !session ? (
          <Card>
            <p className="font-extrabold">請先登入以發起罷免</p>
            <p className="mt-1 text-sm font-medium text-muted-foreground">發起人會被列為領銜人與第一位連署人。</p>
            <Link href={loginUrlFor(`/offices/${id}/recall/new`)} className="mt-3 inline-block">
              <Button variant="primary" size="sm">登入以發起</Button>
            </Link>
          </Card>
        ) : (
          <Card>
            <p className="mb-3 rounded-xl border-2 border-foreground/15 p-3 text-sm font-medium text-muted-foreground">
              連署開放全校師生，惟通過門檻仍以原選區當屆有效票的 2/5 計算。連署達門檻後由選委會審查成立。
            </p>
            <InitiateRecallForm officeId={id} />
          </Card>
        )}
      </div>
    </PublicShell>
  );
}

function Blocked({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <Card>
      <div className="flex items-center gap-2 font-extrabold text-tone-orange-text">
        {icon} {title}
      </div>
      <p className="mt-1 text-sm font-medium text-muted-foreground">{body}</p>
    </Card>
  );
}

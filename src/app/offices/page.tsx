// 公開職務頁：列出現任職務與現任學生，任一登入師生可從這裡發起罷免。
// 免登入可看；不顯示 email（只 name＋grade），避免公開頁洩漏在學名冊。
import type { Metadata } from "next";
import Link from "next/link";
import { Briefcase, ShieldAlert } from "lucide-react";
import { PublicShell } from "@/components/public/Shell";
import { getSession } from "@/lib/tpass-auth";
import { isAdmin } from "@/config/admin";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/components/public/shared";

export const metadata: Metadata = { title: "現任職務｜T-Vote" };

interface Member {
  name: string;
  grade?: string;
}

function memberLabel(v: unknown): string {
  if (!Array.isArray(v)) return "（未填）";
  return (
    v
      .map((m) => {
        const mem = m as Member;
        return mem?.grade ? `${mem.name}（${mem.grade}）` : mem?.name;
      })
      .filter(Boolean)
      .join("、") || "（未填）"
  );
}

export default async function OfficesPublicPage() {
  const session = await getSession();
  const admin = isAdmin(session);
  const offices = await prisma.office.findMany({
    where: { isVacant: false },
    orderBy: { title: "asc" },
  });

  return (
    <PublicShell isLoggedIn={session !== null} isAdmin={admin}>
      <h1 className="font-extrabold text-2xl sm:text-3xl tracking-tight">現任職務</h1>
      <p className="mt-2 font-medium text-muted-foreground">
        由選舉產生的現任職務。任一登入師生皆可對就職滿 2 個月的職務發起罷免連署。
      </p>

      <div className="mt-6 flex flex-col gap-3">
        {offices.map((o) => (
          <div
            key={o.id}
            className="rounded-2xl border-2 border-foreground bg-card p-4 shadow-[3px_3px_0_0_var(--color-foreground)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Briefcase className="h-4 w-4 shrink-0" />
                  <span className="font-extrabold truncate">{o.title}</span>
                </div>
                <p className="mt-1 text-sm font-bold">{memberLabel(o.currentMembers)}</p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {o.startedAt ? `就職 ${formatDateTime(o.startedAt)}` : "就職日未定"}
                </p>
              </div>
              <Link
                href={`/offices/${o.id}/recall/new`}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border-2 border-foreground bg-card px-3 py-1.5 text-sm font-bold text-destructive shadow-[2px_2px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[3px_3px_0_0_var(--color-foreground)]"
              >
                <ShieldAlert className="h-4 w-4" /> 發起罷免
              </Link>
            </div>
          </div>
        ))}
        {offices.length === 0 && (
          <p className="text-sm font-medium text-muted-foreground">目前沒有現任職務。</p>
        )}
      </div>
    </PublicShell>
  );
}

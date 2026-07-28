// 首頁（Server Component）：未登入＝介紹型 landing（免登入可看）＋登入 CTA；
// 登入後＝選舉列表，進行中場次依狀態顯示行動按鈕，已發布結果列出，草稿不顯示。
import Link from "next/link";
import { Vote as VoteIcon, ArrowUpRight, ShieldCheck } from "lucide-react";
import { GithubMark } from "@/components/public/GithubMark";
import { Header } from "@/components/common/Header";
import { PublicFooter } from "@/components/public/Shell";
import { StatusBadge } from "@/components/public/Badges";
import { getSession } from "@/lib/tpass-auth";
import { isAdmin } from "@/config/admin";
import { authConfig } from "@/config/auth";
import { GITHUB_URL } from "@/config/site";
import { prisma } from "@/lib/db";
import { KIND_LABEL, formatDateTime } from "@/components/public/shared";

// 狀態顯示優先序：越前面越急迫，排在列表越前面。
const STATUS_PRIORITY: Record<string, number> = {
  voting: 0,
  registration: 1,
  campaigning: 2,
  closed: 3,
  sealed: 4,
  published: 5,
};

const CTA_LABEL: Record<string, string> = {
  registration: "去登記",
  campaigning: "看公報",
  voting: "去投票",
  closed: "查看詳情",
  sealed: "查看詳情",
  published: "查看結果",
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ logout?: string }>;
}) {
  const session = await getSession();
  const isLoggedIn = session !== null;
  // logout=1 只是 auth 導回來的畫面提示，不是憑證：只有在 session 確實無效時才採信。
  const { logout } = await searchParams;
  const justLoggedOut = !isLoggedIn && logout === "1";

  const admin = isAdmin(session);

  const elections = isLoggedIn
    ? await prisma.election.findMany({
        where: { status: { not: "draft" }, hiddenAt: null },
        select: {
          slug: true,
          title: true,
          kind: true,
          status: true,
          registrationStartsAt: true,
          registrationEndsAt: true,
          votingStartsAt: true,
          votingEndsAt: true,
        },
      })
    : [];
  elections.sort(
    (a, b) => (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99),
  );

  return (
    <>
      <Header
        isLoggedIn={isLoggedIn}
        loginUrl={authConfig.loginUrl}
        logoutUrl={authConfig.logoutUrl}
        portalUrl={authConfig.portalUrl}
        isAdmin={admin}
      />

      <main className="flex-1">
        <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-12 pb-6">
          <span className="inline-flex items-center gap-1.5 rounded-md border-2 border-foreground bg-card px-2 py-0.5 font-mono text-[11px] font-bold shadow-[2px_2px_0_0_var(--color-foreground)]">
            <VoteIcon className="h-3.5 w-3.5" /> 學生會選舉
          </span>
          <h1 className="mt-4 font-extrabold text-3xl sm:text-4xl tracking-tight">
            {justLoggedOut ? "您已登出" : "T-Vote 學生會線上選舉"}
          </h1>
          <p className="mt-2 max-w-2xl font-medium text-muted-foreground">
            {isLoggedIn
              ? "目前公告的選舉場次，點卡片查看詳情。"
              : justLoggedOut
                ? "您已安全登出 T-Vote。要繼續查看選舉，請重新登入。"
                : "學生會長、副會長、班聯會代表選舉的公告、候選人登記與匿名投票，都在這裡進行。選票在你的瀏覽器加密後才送出，伺服器全程只收得到密文——投給誰，只有你自己知道。"}
          </p>
        </section>

        <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-16">
          {!isLoggedIn ? (
            <div className="rounded-2xl border-2 border-dashed border-foreground/30 p-10 text-center">
              <div className="flex flex-wrap items-center justify-center gap-3">
                <a
                  href={authConfig.loginUrl}
                  className="inline-flex items-center gap-2 rounded-xl border-2 border-foreground bg-primary px-5 py-2.5 font-bold text-primary-foreground shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-foreground)]"
                >
                  使用學校帳號登入
                </a>
                <Link
                  href="/about"
                  className="inline-flex items-center gap-2 rounded-xl border-2 border-foreground bg-card px-5 py-2.5 font-bold text-foreground shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-foreground)]"
                >
                  <ShieldCheck className="h-4 w-4" />
                  投票怎麼保密？
                </Link>
              </div>
              <p className="mt-4 text-sm font-medium text-muted-foreground">
                想先了解投票怎麼保密？看
                <Link href="/about" className="mx-1 font-bold text-accent hover:underline">
                  關於本系統
                </Link>
                。原始碼公開，任何人都能檢視：
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 inline-flex items-center gap-1 font-bold text-accent hover:underline"
                >
                  <GithubMark className="h-3.5 w-3.5" />
                  GitHub
                </a>
              </p>
            </div>
          ) : elections.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-foreground/30 p-12 text-center">
              <VoteIcon className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="mt-3 font-bold">目前沒有公告中的選舉</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {elections.map((e) => {
                const relevantDate =
                  e.status === "registration"
                    ? e.registrationEndsAt
                    : e.status === "voting"
                      ? e.votingEndsAt
                      : e.status === "campaigning"
                        ? e.votingStartsAt
                        : null;
                return (
                  <div
                    key={e.slug}
                    className="group relative flex flex-col gap-3 rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_var(--color-foreground)] focus-within:-translate-y-0.5 focus-within:shadow-[6px_6px_0_0_var(--color-foreground)]"
                  >
                    <Link
                      href={`/e/${e.slug}`}
                      aria-label={`查看 ${e.title}`}
                      className="absolute inset-0 z-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />

                    <div className="flex items-center justify-between">
                      <StatusBadge status={e.status} />
                      <span className="font-mono text-[11px] font-bold text-muted-foreground">
                        {KIND_LABEL[e.kind] ?? e.kind}
                      </span>
                    </div>

                    <h2 className="font-extrabold text-lg leading-tight">{e.title}</h2>

                    {relevantDate && (
                      <p className="text-sm font-medium text-foreground/70">
                        {e.status === "registration" && `登記截止 ${formatDateTime(relevantDate)}`}
                        {e.status === "voting" && `投票截止 ${formatDateTime(relevantDate)}`}
                        {e.status === "campaigning" && `投票將於 ${formatDateTime(relevantDate)} 開始`}
                      </p>
                    )}

                    <div className="mt-auto flex items-center justify-between font-bold">
                      <span>{CTA_LABEL[e.status] ?? "查看詳情"}</span>
                      <ArrowUpRight className="h-5 w-5 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      <PublicFooter />
    </>
  );
}

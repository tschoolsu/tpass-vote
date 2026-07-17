// 首頁（Server Component）：Phase 1 骨架占位，選舉列表待 Phase 2 補上。
import { Vote as VoteIcon } from "lucide-react";
import { Header } from "@/components/common/Header";
import { getSession } from "@/lib/tpass-auth";
import { isAdmin } from "@/config/admin";
import { authConfig, loginUrlFor } from "@/config/auth";
import { redirect } from "next/navigation";

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

  // 契約 v2：本服務的 cookie 只在本網域，第一次被造訪時身上什麼都沒有——要主動去 auth
  // 換一張自己的票，使用者才會「從門戶點進來就直接認得」（authorize 那趟是無感的）。
  // 剛登出時不能導，否則會立刻被彈回登入，等於登不出去。
  if (!isLoggedIn && !justLoggedOut) redirect(loginUrlFor("/"));

  const admin = session ? await isAdmin(session.email) : false;

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
          <p className="mt-2 font-medium text-muted-foreground">
            {isLoggedIn
              ? "選舉列表施工中，敬請期待。"
              : justLoggedOut
                ? "您已安全登出 T-Vote。要繼續查看選舉，請重新登入。"
                : "請用學校帳號登入以查看選舉。"}
          </p>
        </section>

        <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-16">
          {!isLoggedIn ? (
            <div className="rounded-2xl border-2 border-dashed border-foreground/30 p-12 text-center">
              <a
                href={authConfig.loginUrl}
                className="inline-flex items-center gap-2 rounded-xl border-2 border-foreground bg-primary px-5 py-2.5 font-bold text-primary-foreground shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-foreground)]"
              >
                使用學校帳號登入
              </a>
            </div>
          ) : (
            <div className="rounded-2xl border-2 border-dashed border-foreground/30 p-12 text-center">
              <VoteIcon className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="mt-3 font-bold">選舉列表施工中</p>
            </div>
          )}
        </section>
      </main>

      <footer className="border-t-2 border-dashed border-foreground/30 py-8">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-between">
          <span className="font-mono text-sm font-extrabold text-foreground">
            T<span className="text-primary">-</span>Vote
          </span>
          <span className="font-mono text-xs font-bold text-muted-foreground">
            © 2026 TSchool 學生會數位部
          </span>
        </div>
      </footer>
    </>
  );
}

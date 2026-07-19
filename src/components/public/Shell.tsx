// 公開端頁面共用外殼：Header + 內容容器 + Footer。server component（純結構，無互動）。
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Header } from "@/components/common/Header";
import { GithubMark } from "@/components/public/GithubMark";
import { authConfig } from "@/config/auth";
import { GITHUB_URL } from "@/config/site";

export function PublicShell({
  children,
  isLoggedIn,
  isAdmin,
  wide = false,
}: {
  children: React.ReactNode;
  isLoggedIn: boolean;
  isAdmin: boolean;
  wide?: boolean;
}) {
  return (
    <>
      <Header
        isLoggedIn={isLoggedIn}
        loginUrl={authConfig.loginUrl}
        logoutUrl={authConfig.logoutUrl}
        portalUrl={authConfig.portalUrl}
        isAdmin={isAdmin}
      />
      <main className="flex-1">
        <div className={`${wide ? "max-w-6xl" : "max-w-3xl"} mx-auto px-4 sm:px-6 py-10`}>
          {children}
        </div>
      </main>
      <PublicFooter />
    </>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t-2 border-dashed border-foreground/30 py-8">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <span className="font-mono text-sm font-extrabold text-foreground">
          T<span className="text-primary">-</span>Vote
        </span>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/about"
            className="inline-flex items-center gap-1.5 rounded-md border-2 border-foreground bg-card px-2.5 py-1 font-mono text-[11px] font-bold text-foreground shadow-[2px_2px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[3px_3px_0_0_var(--color-foreground)]"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            投票怎麼保密？
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border-2 border-foreground bg-card px-2.5 py-1 font-mono text-[11px] font-bold text-foreground shadow-[2px_2px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[3px_3px_0_0_var(--color-foreground)]"
          >
            <GithubMark className="h-3.5 w-3.5" />
            GitHub
          </a>
        </div>

        <span className="font-mono text-xs font-bold text-muted-foreground">
          © 2026 TSchool 學生會數位部
        </span>
      </div>
    </footer>
  );
}

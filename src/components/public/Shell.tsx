// 公開端頁面共用外殼：Header + 內容容器 + Footer。server component（純結構，無互動）。
import { Header } from "@/components/common/Header";
import { authConfig } from "@/config/auth";

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
      <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-between">
        <span className="font-mono text-sm font-extrabold text-foreground">
          T<span className="text-primary">-</span>Vote
        </span>
        <span className="font-mono text-xs font-bold text-muted-foreground">
          © 2026 TSchool 學生會數位部
        </span>
      </div>
    </footer>
  );
}

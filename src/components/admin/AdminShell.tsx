import Link from "next/link";
import { authConfig } from "@/config/auth";
import { PortalLink } from "@/components/common/PortalLink";
import { AdminSidebar, AdminTabBar } from "@/components/admin/AdminNav";

export function AdminShell({
  email,
  children,
}: {
  email: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-50 h-16 bg-background/90 backdrop-blur-md border-b-2 border-foreground/20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-full flex items-center justify-between">
          <div className="flex items-center gap-3">
            <PortalLink href={authConfig.portalUrl} />
            <Link
              href="/admin"
              className="font-mono text-lg font-extrabold tracking-tight text-foreground"
            >
              T<span className="text-primary">-</span>Vote
              <span className="ml-2 rounded-md border-2 border-foreground bg-primary px-1.5 py-0.5 align-middle font-mono text-[10px] font-bold text-primary-foreground">
                選委會
              </span>
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline rounded-md border-2 border-foreground bg-card px-2 py-0.5 font-mono text-[11px] font-bold text-foreground">
              {email}
            </span>
            <form method="post" action={authConfig.logoutUrl} className="ml-1">
              <button
                type="submit"
                className="inline-flex h-11 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-card hover:text-foreground"
              >
                登出
              </button>
            </form>
          </div>
        </div>
      </header>

      <AdminTabBar />

      <div className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8 flex gap-8">
        <AdminSidebar />
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}

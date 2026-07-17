"use client";
// 後台導覽。桌機（≥md）= 左側 sidebar；手機 = header 下方水平捲動 tab bar。
// 照抄 tpass-form/src/components/admin/AdminNav.tsx 的兩用寫法。
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Vote, Users, type LucideIcon } from "lucide-react";

type Item = { href: string; label: string; icon: LucideIcon; superAdminOnly?: boolean };

const ITEMS: Item[] = [
  { href: "/admin", label: "選舉列表", icon: Vote },
  { href: "/admin/members", label: "管理員名單", icon: Users, superAdminOnly: true },
];

function isActive(pathname: string | null, href: string) {
  return href === "/admin" ? pathname === "/admin" : (pathname ?? "").startsWith(href);
}

function itemsFor(superAdmin: boolean) {
  return ITEMS.filter((i) => !i.superAdminOnly || superAdmin);
}

function NavLink({ item, active, onClick }: { item: Item; active: boolean; onClick?: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border-2 border-foreground px-3 py-2 font-bold text-sm shadow-[2px_2px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[3px_3px_0_0_var(--color-foreground)] ${
        active ? "bg-primary text-primary-foreground" : "bg-card text-foreground"
      }`}
    >
      <Icon className="h-4 w-4" />
      {item.label}
    </Link>
  );
}

export function AdminSidebar({ superAdmin }: { superAdmin: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="hidden md:flex w-48 shrink-0 flex-col gap-2">
      {itemsFor(superAdmin).map((item) => (
        <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
      ))}
    </nav>
  );
}

export function AdminTabBar({ superAdmin }: { superAdmin: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="sticky top-16 z-40 border-b-2 border-foreground/20 bg-background/90 backdrop-blur-md md:hidden">
      <div className="flex gap-2 overflow-x-auto px-4 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {itemsFor(superAdmin).map((item) => (
          <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
        ))}
      </div>
    </nav>
  );
}

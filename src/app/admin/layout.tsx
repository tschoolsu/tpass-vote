// /admin 守門：未登入 → 導 login；登入但非管理員 → 顯示 Forbidden（不渲染後台）。
// 這只是 UI 層的第一道擋，每個 server action 內部仍要重呼 requireAdmin/requireSuperAdmin。
import { redirect } from "next/navigation";
import { getSession } from "@/lib/tpass-auth";
import { isAdmin } from "@/config/admin";
import { loginUrlFor } from "@/config/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { Forbidden } from "@/components/admin/Forbidden";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect(loginUrlFor("/admin"));

  if (!isAdmin(session)) {
    return <Forbidden />;
  }

  return <AdminShell email={session.email}>{children}</AdminShell>;
}

import { Crown, Trash2 } from "lucide-react";
import { getSession } from "@/lib/tpass-auth";
import { isSuperAdmin, SUPER_ADMIN_EMAILS } from "@/config/admin";
import { prisma } from "@/lib/db";
import { Badge } from "@/components/ui/primitives";
import { Forbidden } from "@/components/admin/Forbidden";
import { AddMemberForm } from "@/components/admin/AddMemberForm";
import { BulkAddMembersForm } from "@/components/admin/BulkAddMembersForm";
import { removeAdminAction } from "./actions";

export default async function MembersPage() {
  // layout 已擋掉非 admin；這頁再加一層：只有超管能管名單。
  const session = await getSession();
  if (!session || !isSuperAdmin(session.email)) {
    return <Forbidden title="僅限超級管理員" message="只有種子超管能管理選委會成員名單。" />;
  }

  const members = await prisma.admin.findMany({ orderBy: { createdAt: "asc" } });

  return (
    <div>
      <h1 className="font-extrabold text-2xl tracking-tight mb-2">選委會成員名單</h1>
      <p className="font-medium text-muted-foreground mb-6">
        名單上的帳號登入後即可管理選舉、審核候選人與開票。
      </p>

      <div className="rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)] mb-6">
        <h2 className="font-bold mb-3">新增成員</h2>
        <AddMemberForm />
      </div>

      <div className="rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)] mb-6">
        <h2 className="font-bold mb-1">批次貼上匯入</h2>
        <p className="mb-3 font-medium text-sm text-muted-foreground">
          一行一個 email，貼上後先解析預覽，確認無誤再送出。
        </p>
        <BulkAddMembersForm />
      </div>

      <div className="flex flex-col gap-3">
        {/* 種子超管（env，不可移除）*/}
        {SUPER_ADMIN_EMAILS.map((email) => (
          <div
            key={email}
            className="flex items-center justify-between gap-3 rounded-2xl border-2 border-foreground bg-tone-violet-bg p-4 shadow-[3px_3px_0_0_var(--color-foreground)]"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Crown className="h-4 w-4 shrink-0 text-tone-violet-text" />
              <span className="font-bold truncate">{email}</span>
            </div>
            <Badge className="bg-card shrink-0">種子超管</Badge>
          </div>
        ))}

        {/* DB 名單（可移除）*/}
        {members.map((m) => (
          <div
            key={m.id}
            className="flex items-center justify-between gap-3 rounded-2xl border-2 border-foreground bg-card p-4 shadow-[3px_3px_0_0_var(--color-foreground)]"
          >
            <div className="min-w-0">
              <span className="block truncate font-bold">{m.email}</span>
              <p className="font-mono text-[11px] text-muted-foreground">
                由 {m.addedBy} 新增 · {m.createdAt.toLocaleDateString("zh-TW")}
              </p>
            </div>
            <form action={removeAdminAction}>
              <input type="hidden" name="id" value={m.id} />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-xl border-2 border-foreground bg-card px-3 py-1.5 text-sm font-bold text-destructive shadow-[2px_2px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[3px_3px_0_0_var(--color-foreground)]"
              >
                <Trash2 className="h-4 w-4" /> 移除
              </button>
            </form>
          </div>
        ))}

        {members.length === 0 && (
          <p className="text-sm font-medium text-muted-foreground">
            目前沒有額外成員，只有種子超管能管理選舉。
          </p>
        )}
      </div>
    </div>
  );
}

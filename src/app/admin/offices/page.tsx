// 職務登記表：職務 → 現任學生。由選舉公告自動落地，選委可手動新增／編輯（每筆都留編輯記錄）。
import Link from "next/link";
import { Plus, Briefcase, ChevronRight } from "lucide-react";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { Badge, Button } from "tpass-ui";
import { formatDateTime } from "@/components/public/shared";

interface Member {
  name: string;
}

function memberNames(v: unknown): string {
  return Array.isArray(v) ? v.map((m) => (m as Member)?.name).filter(Boolean).join("、") : "";
}

export default async function OfficesPage() {
  await requireAdmin("/admin/offices");
  const offices = await prisma.office.findMany({ orderBy: [{ isVacant: "asc" }, { title: "asc" }] });
  const sourceIds = [...new Set(offices.map((o) => o.sourceElectionId).filter((x): x is string => !!x))];
  const sources =
    sourceIds.length > 0
      ? await prisma.election.findMany({ where: { id: { in: sourceIds } }, select: { id: true, slug: true, title: true } })
      : [];
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-extrabold text-2xl tracking-tight mb-1">職務登記表</h1>
          <p className="font-medium text-muted-foreground">
            選舉公告結果時自動帶入現任與入職日；也可手動維護。是公開發起罷免的對象來源。
          </p>
        </div>
        <Link href="/admin/offices/new">
          <Button variant="primary" size="sm">
            <Plus className="h-4 w-4" /> 新增職務
          </Button>
        </Link>
      </div>

      <div className="flex flex-col gap-3">
        {offices.map((o) => {
          const src = o.sourceElectionId ? sourceById.get(o.sourceElectionId) : null;
          return (
            <Link
              key={o.id}
              href={`/admin/offices/${o.id}`}
              className="flex items-center justify-between gap-3 rounded-2xl border-2 border-foreground bg-card p-4 shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-foreground)]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Briefcase className="h-4 w-4 shrink-0" />
                  <span className="font-extrabold truncate">{o.title}</span>
                  {o.isVacant ? (
                    <Badge className="bg-tone-orange-bg text-tone-orange-text">從缺</Badge>
                  ) : (
                    <Badge className="bg-primary text-primary-foreground">現任</Badge>
                  )}
                </div>
                <p className="mt-1 text-sm font-medium truncate">
                  {o.isVacant ? "（目前無現任）" : memberNames(o.currentMembers) || "（未填姓名）"}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {o.startedAt ? `入職 ${formatDateTime(o.startedAt)}` : "入職日未定"}
                  {src ? ` · 來源：${src.title}` : ""}
                </p>
              </div>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
            </Link>
          );
        })}
        {offices.length === 0 && (
          <p className="text-sm font-medium text-muted-foreground">
            目前沒有職務。選舉公告結果後會自動建立，或點右上「新增職務」手動加。
          </p>
        )}
      </div>
    </div>
  );
}

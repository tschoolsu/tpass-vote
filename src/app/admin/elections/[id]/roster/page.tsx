import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { Card, Badge } from "@/components/ui/primitives";
import { RosterImportForm } from "@/components/admin/RosterImportForm";
import { ConfirmActionButton } from "@/components/admin/ConfirmActionButton";
import { removeVoter } from "./actions";

const LOCKED_STATUSES = new Set(["voting", "closed", "sealed", "published"]);

export default async function RosterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireAdmin(`/admin/elections/${id}/roster`);

  const election = await prisma.election.findUnique({
    where: { id },
    include: { voters: { orderBy: { email: "asc" } } },
  });
  if (!election) notFound();

  const rosterCount = election.voters.length;
  const votedCount = election.voters.filter((v) => v.votedAt !== null).length;
  const turnoutPct = rosterCount > 0 ? Math.round((votedCount / rosterCount) * 1000) / 10 : 0;
  const locked = LOCKED_STATUSES.has(election.status);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-extrabold text-2xl tracking-tight">選舉人名冊</h1>
        <p className="font-mono text-xs text-muted-foreground">
          {election.title} · 投票率 {turnoutPct}%（{votedCount}/{rosterCount}）
        </p>
      </div>

      <Card>
        <h2 className="font-bold mb-1">匯入名冊</h2>
        <p className="mb-3 text-sm font-medium text-muted-foreground">
          每行一個 email，可用逗號加姓名：<span className="font-mono">email,姓名</span>
          。重複 email 會更新姓名，不會重複建立。
        </p>
        <RosterImportForm electionId={election.id} />
      </Card>

      {locked && (
        <p className="text-sm font-medium text-muted-foreground">
          投票已開始，名冊只能新增，不能刪除既有條目。
        </p>
      )}

      <div className="flex flex-col gap-2">
        {election.voters.map((v) => (
          <div
            key={v.id}
            className="flex items-center justify-between gap-3 rounded-2xl border-2 border-foreground bg-card p-3 shadow-[2px_2px_0_0_var(--color-foreground)]"
          >
            <div className="min-w-0">
              <p className="font-bold truncate">{v.name ?? v.email}</p>
              {v.name && <p className="font-mono text-[11px] text-muted-foreground truncate">{v.email}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {v.votedAt ? (
                <Badge className="bg-tone-green-badge text-tone-green-text">
                  已投票 {v.votedAt.toLocaleString("zh-TW")}
                </Badge>
              ) : (
                <Badge className="bg-card">尚未投票</Badge>
              )}
              {!locked && (
                <ConfirmActionButton
                  action={removeVoter.bind(null, election.id, v.id)}
                  label="移除"
                  variant="destructive"
                  size="sm"
                  confirmMessage={`確定要把 ${v.email} 從名冊移除嗎？`}
                />
              )}
            </div>
          </div>
        ))}
        {election.voters.length === 0 && (
          <p className="text-sm font-medium text-muted-foreground">尚未匯入任何選舉人。</p>
        )}
      </div>
    </div>
  );
}

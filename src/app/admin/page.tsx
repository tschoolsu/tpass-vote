import Link from "next/link";
import { Plus, Vote as VoteIcon, ArrowUpRight, Trash2 } from "lucide-react";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { Badge } from "tpass-ui";
import { ConfirmActionButton } from "@/components/admin/ConfirmActionButton";
import { STATUS_META, LINEAGE_LABEL, RECALL_KIND_META, type ElectionStatus } from "@/components/admin/status";
import { ELECTION_KIND_LABEL, type ElectionKind } from "@/app/admin/elections/election-schema";
import { restoreElection } from "@/app/admin/elections/[id]/actions";

function KindBadges({ kind, lineage }: { kind: string; lineage: string | null }) {
  const kindMeta = kind === "recall" ? RECALL_KIND_META : { label: ELECTION_KIND_LABEL[kind as ElectionKind] ?? kind, badgeClass: "bg-card" };
  const lineageMeta = lineage ? LINEAGE_LABEL[lineage] : null;
  return (
    <>
      <Badge className={kindMeta.badgeClass}>{kindMeta.label}</Badge>
      {lineageMeta && <Badge className={lineageMeta.badgeClass}>{lineageMeta.label}</Badge>}
    </>
  );
}

export default async function AdminHomePage() {
  await requireAdmin();

  const allElections = await prisma.election.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      voters: { select: { votedAt: true } },
      _count: { select: { candidates: true } },
    },
  });

  // 隱藏（軟刪除）的選舉預設不列在主列表，但保留還原入口，不真的消失。
  const elections = allElections.filter((e) => e.hiddenAt === null);
  const hiddenElections = allElections.filter((e) => e.hiddenAt !== null);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-6">
        <h1 className="font-extrabold text-2xl tracking-tight">所有選舉</h1>
        <Link
          href="/admin/elections/new"
          className="inline-flex items-center gap-2 rounded-xl border-2 border-foreground bg-primary px-4 py-2 font-bold text-primary-foreground shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-foreground)] active:translate-y-0 active:shadow-[2px_2px_0_0_var(--color-foreground)]"
        >
          <Plus className="h-4 w-4" /> 新增選舉
        </Link>
      </div>

      {elections.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-foreground/30 p-12 text-center">
          <VoteIcon className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="mt-3 font-bold">還沒有選舉</p>
          <p className="mt-1 text-sm font-medium text-muted-foreground">
            點右上角「新增選舉」開始建立第一場。
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {elections.map((e) => {
            const rosterCount = e.voters.length;
            const votedCount = e.voters.filter((v) => v.votedAt !== null).length;
            const turnoutPct =
              rosterCount > 0 ? Math.round((votedCount / rosterCount) * 1000) / 10 : null;
            const status = e.status as ElectionStatus;
            const meta = STATUS_META[status] ?? STATUS_META.draft;

            return (
              <li key={e.id}>
                <Link
                  href={`/admin/elections/${e.id}`}
                  className="group flex items-center justify-between gap-4 rounded-2xl border-2 border-foreground bg-card p-4 shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-foreground)]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-extrabold truncate">{e.title}</span>
                      <Badge className={meta.badgeClass}>{meta.label}</Badge>
                      <KindBadges kind={e.kind} lineage={e.lineage} />
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      /e/{e.slug} · 名額 {e.seats} · 候選人 {e._count.candidates} 組
                      {rosterCount > 0 && (
                        <>
                          {" "}
                          · 投票率 {turnoutPct}%（{votedCount}/{rosterCount}）
                        </>
                      )}
                    </p>
                  </div>
                  <ArrowUpRight className="h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {hiddenElections.length > 0 && (
        <details className="mt-8 group">
          <summary className="flex cursor-pointer items-center gap-2 font-mono text-xs font-bold text-muted-foreground">
            <Trash2 className="h-3.5 w-3.5" />
            已刪除（{hiddenElections.length}）
          </summary>
          <ul className="mt-3 flex flex-col gap-3">
            {hiddenElections.map((e) => {
              const status = e.status as ElectionStatus;
              const meta = STATUS_META[status] ?? STATUS_META.draft;
              return (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-4 rounded-2xl border-2 border-dashed border-foreground/30 bg-card p-4 opacity-70"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-extrabold truncate">{e.title}</span>
                      <Badge className={meta.badgeClass}>{meta.label}</Badge>
                      <KindBadges kind={e.kind} lineage={e.lineage} />
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      /e/{e.slug} · 已於 {e.hiddenAt?.toLocaleString("zh-TW")} 刪除
                    </p>
                  </div>
                  <ConfirmActionButton
                    action={restoreElection.bind(null, e.id)}
                    label="還原"
                    size="sm"
                    confirmMessage={`確定要還原「${e.title}」嗎？還原後會重新出現在所有列表中。`}
                  />
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

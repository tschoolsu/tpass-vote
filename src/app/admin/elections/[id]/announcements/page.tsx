import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { AnnouncementEditor } from "@/components/admin/AnnouncementEditor";

const KIND_LABEL = {
  first: "公告一（登記／投票公告，投票日前 30 日）",
  second: "公告二（候選人名單公告，投票日前 14 日）",
  result: "結果公告（開票後 7 日內）",
} as const;

function shiftDays(d: Date | null, days: number): Date | null {
  return d ? new Date(d.getTime() + days * 86400000) : null;
}

function fmt(d: Date | null): string {
  return d ? d.toLocaleString("zh-TW") : "尚未設定投票期程，無法估算";
}

export default async function AnnouncementsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireAdmin(`/admin/elections/${id}/announcements`);

  const election = await prisma.election.findUnique({
    where: { id },
    include: { announcements: true },
  });
  if (!election) notFound();

  const byKind = new Map(election.announcements.map((a) => [a.kind, a]));
  const firstDeadline = shiftDays(election.votingStartsAt, -30);
  const secondDeadline = shiftDays(election.votingStartsAt, -14);
  const resultDeadline = shiftDays(election.sealedAt ?? election.votingEndsAt, 7);

  const resultBlockedReason = !election.resultsJson
    ? "尚未在開票頁提交計票結果，無法發布結果公告"
    : election.status !== "sealed"
      ? "選舉狀態不是「已彌封」，無法發布結果公告（可能已公告過）"
      : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-extrabold text-2xl tracking-tight">公告管理</h1>
        <p className="font-mono text-xs text-muted-foreground">{election.title}</p>
      </div>

      <AnnouncementEditor
        electionId={election.id}
        kind="first"
        kindLabel={KIND_LABEL.first}
        initialTitle={byKind.get("first")?.title ?? ""}
        initialBody={byKind.get("first")?.body ?? ""}
        publishedAt={byKind.get("first")?.publishedAt ?? null}
        deadlineHint={`建議發布時限：${fmt(firstDeadline)}`}
      />
      <AnnouncementEditor
        electionId={election.id}
        kind="second"
        kindLabel={KIND_LABEL.second}
        initialTitle={byKind.get("second")?.title ?? ""}
        initialBody={byKind.get("second")?.body ?? ""}
        publishedAt={byKind.get("second")?.publishedAt ?? null}
        deadlineHint={`建議發布時限：${fmt(secondDeadline)}`}
      />
      <AnnouncementEditor
        electionId={election.id}
        kind="result"
        kindLabel={KIND_LABEL.result}
        initialTitle={byKind.get("result")?.title ?? ""}
        initialBody={byKind.get("result")?.body ?? ""}
        publishedAt={byKind.get("result")?.publishedAt ?? null}
        deadlineHint={`建議發布時限：${fmt(resultDeadline)}`}
        publishDisabledReason={byKind.get("result")?.publishedAt ? undefined : resultBlockedReason}
      />
    </div>
  );
}

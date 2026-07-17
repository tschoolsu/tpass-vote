import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { CandidateReviewCard } from "@/components/admin/CandidateReviewCard";

const LOCKED_STATUSES = new Set(["voting", "closed", "sealed", "published"]);

function attachmentIds(attachments: unknown): string[] {
  return Array.isArray(attachments) ? attachments.filter((x): x is string => typeof x === "string") : [];
}

export default async function CandidatesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireAdmin(`/admin/elections/${id}/candidates`);

  const election = await prisma.election.findUnique({
    where: { id },
    include: { candidates: true },
  });
  if (!election) notFound();

  const sorted = [...election.candidates].sort((a, b) => {
    if (a.number === null && b.number !== null) return 1;
    if (a.number !== null && b.number === null) return -1;
    if (a.number !== null && b.number !== null) return a.number - b.number;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const allAttachmentIds = [...new Set(sorted.flatMap((c) => attachmentIds(c.attachments)))];
  const uploads =
    allAttachmentIds.length > 0
      ? await prisma.upload.findMany({
          where: { id: { in: allAttachmentIds } },
          select: { id: true, filename: true },
        })
      : [];
  const uploadMap = new Map(uploads.map((u) => [u.id, u]));

  const locked = LOCKED_STATUSES.has(election.status);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-extrabold text-2xl tracking-tight">候選人審核</h1>
        <p className="font-mono text-xs text-muted-foreground">
          {election.title} · 共 {sorted.length} 組登記
        </p>
      </div>

      {locked && (
        <p className="text-sm font-medium text-muted-foreground">
          投票已開始，候選人名單已鎖定，不能再核准/退回/拒絕。
        </p>
      )}

      {sorted.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-foreground/30 p-12 text-center">
          <p className="font-bold">尚無候選人登記</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {sorted.map((c) => (
            <CandidateReviewCard
              key={c.id}
              electionId={election.id}
              candidate={{
                id: c.id,
                number: c.number,
                status: c.status,
                platform: c.platform,
                members: c.members,
                reviewNote: c.reviewNote,
                createdBy: c.createdBy,
              }}
              attachmentFiles={attachmentIds(c.attachments)
                .map((aid) => uploadMap.get(aid))
                .filter((u): u is { id: string; filename: string } => Boolean(u))}
              locked={locked}
            />
          ))}
        </div>
      )}
    </div>
  );
}

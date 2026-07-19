// ②登記面板：候選人審核清單。純組裝，重用既有 CandidateReviewCard 與其內部 action。
import { CandidateReviewCard } from "@/components/admin/CandidateReviewCard";

interface CandidateRow {
  id: string;
  number: number | null;
  status: string;
  platform: string;
  members: unknown;
  reviewNote: string | null;
  createdBy: string;
  attachments: unknown;
}

function attachmentIds(attachments: unknown): string[] {
  return Array.isArray(attachments) ? attachments.filter((x): x is string => typeof x === "string") : [];
}

export function RegistrationPanel({
  electionId,
  candidates,
  uploads,
  locked,
}: {
  electionId: string;
  candidates: CandidateRow[];
  uploads: { id: string; filename: string }[];
  locked: boolean;
}) {
  const sorted = [...candidates].sort((a, b) => {
    if (a.number === null && b.number !== null) return 1;
    if (a.number !== null && b.number === null) return -1;
    if (a.number !== null && b.number !== null) return a.number - b.number;
    return 0;
  });
  const uploadMap = new Map(uploads.map((u) => [u.id, u]));

  if (sorted.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-foreground/30 p-8 text-center">
        <p className="font-bold">尚無候選人登記</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {locked && (
        <p className="text-sm font-medium text-muted-foreground">
          投票已開始，候選人名單已鎖定，不能再核准/退回/拒絕。
        </p>
      )}
      {sorted.map((c) => (
        <CandidateReviewCard
          key={c.id}
          electionId={electionId}
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
  );
}

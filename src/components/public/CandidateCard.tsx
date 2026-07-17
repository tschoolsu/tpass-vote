// 候選人資訊展示：號次、成員姓名、政見（原生 <details> 摺疊，免 JS）。
// 純展示、無 hooks，server / client 兩邊都能安全複用（投票頁的互動卡片內也會包這個）。
import { Badge } from "@/components/ui/primitives";
import { candidateDisplayName, type MemberInfo } from "@/components/public/shared";

export interface PublicCandidate {
  id: string;
  number: number | null;
  members: MemberInfo[];
  platform: string;
}

export function CandidateInfo({ kind, candidate }: { kind: string; candidate: PublicCandidate }) {
  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge className="text-sm">
          {candidate.number !== null ? `${candidate.number} 號` : "號次未編定"}
        </Badge>
      </div>
      <h3 className="font-extrabold text-lg leading-tight">
        {candidateDisplayName(kind, candidate.members)}
      </h3>
      <details className="group text-sm">
        <summary className="cursor-pointer font-bold text-accent select-none">
          政見
        </summary>
        <p className="mt-1.5 whitespace-pre-wrap font-medium text-foreground/80">
          {candidate.platform}
        </p>
      </details>
    </div>
  );
}

export function CandidateCard({ kind, candidate }: { kind: string; candidate: PublicCandidate }) {
  return (
    <div className="rounded-2xl border-2 border-foreground bg-card p-4 shadow-[4px_4px_0_0_var(--color-foreground)]">
      <CandidateInfo kind={kind} candidate={candidate} />
    </div>
  );
}

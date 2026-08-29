// 候選人資訊展示：大頭照、號次、成員姓名、政見（markdown 渲染）。
// 純展示、無 hooks，server / client 兩邊都能安全複用（投票頁的互動卡片內也會包這個）。
// `expanded`：預設 false（原生 <details> 摺疊，免 JS）；投票頁傳 true 直接展開，
// 讓投票當下政見資訊明確可見，不用多一次點擊。
//
// 大頭照走公開路徑 /api/photos/[id]（免 admin，選罷法第二十二條要求選票載明相片）；
// 學生證影本等私密附件維持走 /api/files/[id]（admin-only），這裡完全不碰。
import { User } from "lucide-react";
import { Badge } from "tpass-ui";
import { candidateDisplayName, type MemberInfo } from "@/components/public/shared";
import { Markdown } from "@/components/public/Markdown";

export interface PublicCandidate {
  id: string;
  number: number | null;
  members: MemberInfo[];
  platform: string;
}

function MemberAvatar({ member }: { member: MemberInfo }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-foreground bg-muted">
        {member.photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- 來自我方 /api/photos，不是外部圖，不需要 next/image。
          <img
            src={`/api/photos/${member.photo}`}
            alt={`${member.name}大頭照`}
            className="h-full w-full object-cover"
          />
        ) : (
          <User className="h-4 w-4 text-muted-foreground" aria-label={`${member.name}無大頭照`} />
        )}
      </div>
      <span className="font-mono text-[11px] font-bold text-muted-foreground">{member.name}</span>
    </div>
  );
}

export function CandidateInfo({
  kind,
  candidate,
  expanded = false,
}: {
  kind: string;
  candidate: PublicCandidate;
  expanded?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge className="text-sm">
          {candidate.number !== null ? `${candidate.number} 號` : "號次未編定"}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {candidate.members.map((m, i) => (
          <MemberAvatar key={i} member={m} />
        ))}
      </div>
      <h3 className="font-extrabold text-lg leading-tight">
        {candidateDisplayName(kind, candidate.members)}
      </h3>
      {expanded ? (
        <div className="text-sm">
          <p className="font-bold text-accent">政見</p>
          <div className="mt-1.5 text-foreground/80">
            <Markdown text={candidate.platform} />
          </div>
        </div>
      ) : (
        <details className="group text-sm">
          <summary className="cursor-pointer font-bold text-accent select-none">
            政見
          </summary>
          <div className="mt-1.5 text-foreground/80">
            <Markdown text={candidate.platform} />
          </div>
        </details>
      )}
    </div>
  );
}

export function CandidateCard({
  kind,
  candidate,
  expanded = false,
}: {
  kind: string;
  candidate: PublicCandidate;
  expanded?: boolean;
}) {
  return (
    <div className="rounded-2xl border-2 border-foreground bg-card p-4 shadow-[4px_4px_0_0_var(--color-foreground)]">
      <CandidateInfo kind={kind} candidate={candidate} expanded={expanded} />
    </div>
  );
}

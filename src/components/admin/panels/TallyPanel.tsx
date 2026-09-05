// ⑥開票面板：直接嵌現有 TallyClient（金鑰上傳→本地解密計票→提交結果），完全不改動其
// 加密/解密/submitResults 的既有邏輯與 client state，只是把它從獨立路由搬進工作台當一個 section。
import { TallyClient } from "@/components/admin/TallyClient";

interface CandidateMember {
  name: string;
  email: string;
  grade?: string;
}

interface CandidateRow {
  id: string;
  number: number | null;
  members: unknown;
}

export function TallyPanel({
  electionId,
  slug,
  status,
  ballotMode,
  sealedBox,
  sealedHash,
  keyShares,
  resultsExist,
  seats,
  maxChoices,
  rosterCount,
  approvedCandidates,
}: {
  electionId: string;
  slug: string;
  status: string;
  ballotMode: string | null;
  sealedBox: unknown;
  sealedHash: string | null;
  keyShares: number;
  resultsExist: boolean;
  seats: number;
  maxChoices: number;
  rosterCount: number;
  approvedCandidates: CandidateRow[];
}) {
  if (status !== "sealed" && status !== "published") {
    return (
      <p className="text-sm font-medium text-muted-foreground">
        尚未彌封，無法開票。請先在「⑤截止」面板把票匭彌封。
      </p>
    );
  }

  if (!ballotMode || !Array.isArray(sealedBox)) {
    return (
      <p role="alert" className="font-bold text-sm text-destructive">
        選舉資料不完整（缺少投票模式或票匭快照），無法開票，請聯絡開發團隊確認資料狀態。
      </p>
    );
  }

  const sortedCandidates = [...approvedCandidates].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const candidateLabels: Record<string, string> = {};
  for (const c of sortedCandidates) {
    const members = Array.isArray(c.members) ? (c.members as unknown as CandidateMember[]) : [];
    const names = members.map((m) => m.name).join("、") || c.id;
    candidateLabels[c.id] = c.number ? `${c.number} 號 ${names}` : names;
  }

  return (
    <TallyClient
      electionId={electionId}
      slug={slug}
      sealedBox={sealedBox as string[]}
      sealedHash={sealedHash}
      keyShares={keyShares}
      alreadySubmitted={resultsExist}
      meta={{
        electionId,
        slug,
        ballotMode: ballotMode as "choose" | "approval",
        seats,
        maxChoices,
        candidateIds: sortedCandidates.map((c) => c.id),
        rosterCount,
      }}
      candidateLabels={candidateLabels}
    />
  );
}

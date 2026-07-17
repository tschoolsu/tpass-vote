import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui/primitives";
import { TallyClient } from "@/components/admin/TallyClient";

interface CandidateMember {
  name: string;
  email: string;
  grade?: string;
}

export default async function TallyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireAdmin(`/admin/elections/${id}/tally`);

  const election = await prisma.election.findUnique({
    where: { id },
    include: {
      candidates: { where: { status: "approved" } },
      _count: { select: { voters: true } },
    },
  });
  if (!election) notFound();

  if (election.status !== "sealed" && election.status !== "published") {
    return (
      <div className="max-w-xl">
        <h1 className="font-extrabold text-2xl tracking-tight mb-4">開票</h1>
        <Card>
          <p className="font-bold">尚未彌封，無法開票。</p>
          <p className="mt-1 text-sm text-muted-foreground">
            請先在選舉總覽頁把狀態推進到「已截止」，再彌封票匭。
          </p>
        </Card>
      </div>
    );
  }

  if (!election.ballotMode || !Array.isArray(election.sealedBox)) {
    return (
      <div className="max-w-xl">
        <h1 className="font-extrabold text-2xl tracking-tight mb-4">開票</h1>
        <Card>
          <p className="font-bold text-destructive">
            選舉資料不完整（缺少投票模式或票匭快照），無法開票，請聯絡開發團隊確認資料狀態。
          </p>
        </Card>
      </div>
    );
  }

  const sortedCandidates = [...election.candidates].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const candidateLabels: Record<string, string> = {};
  for (const c of sortedCandidates) {
    const members = Array.isArray(c.members) ? (c.members as unknown as CandidateMember[]) : [];
    const names = members.map((m) => m.name).join("、") || c.id;
    candidateLabels[c.id] = c.number ? `${c.number} 號 ${names}` : names;
  }

  const sealedBox = election.sealedBox as string[];

  return (
    <div className="max-w-3xl">
      <h1 className="font-extrabold text-2xl tracking-tight mb-1">開票</h1>
      <p className="mb-6 font-mono text-xs text-muted-foreground">{election.title}</p>

      <TallyClient
        electionId={election.id}
        slug={election.slug}
        sealedBox={sealedBox}
        sealedHash={election.sealedHash}
        keyShares={election.keyShares}
        alreadySubmitted={election.resultsJson !== null}
        meta={{
          electionId: election.id,
          slug: election.slug,
          ballotMode: election.ballotMode as "choose" | "approval",
          seats: election.seats,
          maxChoices: election.maxChoices,
          candidateIds: sortedCandidates.map((c) => c.id),
          rosterCount: election._count.voters,
        }}
        candidateLabels={candidateLabels}
      />
    </div>
  );
}

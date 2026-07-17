import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui/primitives";
import { EditElectionClient } from "@/components/admin/EditElectionClient";
import type { ElectionFormInitial } from "@/components/admin/ElectionForm";
import { updateElection } from "./actions";

const LOCKED_STATUSES = new Set(["voting", "closed", "sealed", "published"]);

export default async function EditElectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireAdmin(`/admin/elections/${id}/edit`);

  const election = await prisma.election.findUnique({ where: { id } });
  if (!election) notFound();

  if (LOCKED_STATUSES.has(election.status)) {
    return (
      <div className="max-w-xl">
        <h1 className="font-extrabold text-2xl tracking-tight mb-4">編輯選舉</h1>
        <Card>
          <p className="font-bold">投票已開始，選舉基本資料已鎖定，不可再修改。</p>
          <p className="mt-1 text-sm text-muted-foreground">如需調整名額或期程，請建立新的選舉場次。</p>
        </Card>
      </div>
    );
  }

  const initial: ElectionFormInitial = {
    title: election.title,
    slug: election.slug,
    kind: election.kind as ElectionFormInitial["kind"],
    seats: election.seats,
    maxChoices: election.maxChoices,
    registrationStartsAt: election.registrationStartsAt,
    registrationEndsAt: election.registrationEndsAt,
    votingStartsAt: election.votingStartsAt,
    votingEndsAt: election.votingEndsAt,
  };

  return (
    <div className="max-w-xl">
      <h1 className="font-extrabold text-2xl tracking-tight mb-6">編輯選舉</h1>
      <EditElectionClient electionId={election.id} initial={initial} action={updateElection.bind(null, election.id)} />
    </div>
  );
}

// 選舉工作台：單頁線性入口，取代舊的總覽頁＋跳頁子頁（roster/candidates/edit/tally/announcements
// 現在都 redirect 回這裡，見各自的 page.tsx）。這裡只做一次性資料撈取，UI 組裝全在
// ElectionWorkbench（client component）與其下的 panels/*。
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { authConfig } from "@/config/auth";
import { recallThreshold } from "@/lib/recall";
import type { TallyResult } from "@/lib/tally";
import { ElectionWorkbench, type RecallInfo } from "@/components/admin/panels/ElectionWorkbench";

function attachmentIds(attachments: unknown): string[] {
  return Array.isArray(attachments) ? attachments.filter((x): x is string => typeof x === "string") : [];
}

export default async function ElectionWorkbenchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireAdmin(`/admin/elections/${id}`);

  const election = await prisma.election.findUnique({
    where: { id },
    include: {
      candidates: true,
      voters: { orderBy: { email: "asc" } },
      announcements: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!election) notFound();

  const allAttachmentIds = [...new Set(election.candidates.flatMap((c) => attachmentIds(c.attachments)))];
  const uploads =
    allAttachmentIds.length > 0
      ? await prisma.upload.findMany({
          where: { id: { in: allAttachmentIds } },
          select: { id: true, filename: true },
        })
      : [];

  // 罷免案專屬：連署門檻算自原選舉的計票結果，連署人清單具名（選委可見 email），
  // 名字靠這場自己的 Voter 名冊（建罷免案當下已複製自原選舉名冊）反查，不必回頭查 parent。
  let recallInfo: RecallInfo | null = null;
  if (election.kind === "recall") {
    const [signatures, parent] = await Promise.all([
      prisma.recallSignature.findMany({ where: { electionId: id }, orderBy: { createdAt: "asc" } }),
      election.parentId
        ? prisma.election.findUnique({ where: { id: election.parentId }, select: { resultsJson: true } })
        : Promise.resolve(null),
    ]);
    const parentResults = (parent?.resultsJson as unknown as TallyResult | null) ?? null;
    const threshold = parentResults ? recallThreshold(parentResults.validCount) : 0;
    const voterNameByEmail = new Map(election.voters.map((v) => [v.email, v.name]));
    recallInfo = {
      threshold,
      signatures: signatures.map((s) => ({
        email: s.signerEmail,
        name: voterNameByEmail.get(s.signerEmail) ?? null,
        createdAt: s.createdAt,
      })),
    };
  }

  return (
    <ElectionWorkbench election={election} uploads={uploads} selfUrl={authConfig.selfUrl} recallInfo={recallInfo} />
  );
}

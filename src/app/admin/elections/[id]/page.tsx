// 選舉工作台：單頁線性入口，取代舊的總覽頁＋跳頁子頁（roster/candidates/edit/tally/announcements
// 現在都 redirect 回這裡，見各自的 page.tsx）。這裡只做一次性資料撈取，UI 組裝全在
// ElectionWorkbench（client component）與其下的 panels/*。
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { authConfig } from "@/config/auth";
import { isSuperAdmin } from "@/config/admin";
import { recallThreshold } from "@/lib/recall";
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
  const admin = await requireAdmin(`/admin/elections/${id}`);

  const election = await prisma.election.findUnique({
    where: { id },
    include: {
      candidates: true,
      voters: { orderBy: { email: "asc" } },
      announcements: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!election) notFound();

  const offices = await prisma.office.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } });

  const allAttachmentIds = [...new Set(election.candidates.flatMap((c) => attachmentIds(c.attachments)))];
  const uploads =
    allAttachmentIds.length > 0
      ? await prisma.upload.findMany({
          where: { id: { in: allAttachmentIds } },
          select: { id: true, filename: true },
        })
      : [];

  // 罷免案專屬：連署門檻＝罷免對象職務落地時的「當屆有效票」快照（Office.termValidCount）× 2/5。
  // 連署開放全校、petition 階段無名冊，故連署人只顯示 email（無法反查姓名）。
  let recallInfo: RecallInfo | null = null;
  if (election.kind === "recall") {
    const [signatures, office] = await Promise.all([
      prisma.recallSignature.findMany({ where: { electionId: id }, orderBy: { createdAt: "asc" } }),
      election.recallTargetOfficeId
        ? prisma.office.findUnique({ where: { id: election.recallTargetOfficeId }, select: { termValidCount: true } })
        : Promise.resolve(null),
    ]);
    const threshold = office?.termValidCount != null ? recallThreshold(office.termValidCount) : 0;
    recallInfo = {
      threshold,
      signatures: signatures.map((s) => ({
        email: s.signerEmail,
        name: null,
        createdAt: s.createdAt,
      })),
    };
  }

  return (
    <ElectionWorkbench
      election={election}
      uploads={uploads}
      selfUrl={authConfig.selfUrl}
      recallInfo={recallInfo}
      offices={offices}
      isSuperAdmin={isSuperAdmin(admin)}
    />
  );
}

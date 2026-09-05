import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, History } from "lucide-react";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { ElectionAuditLogTimeline } from "@/components/admin/panels/ElectionAuditLogTimeline";

export default async function ElectionAuditLogPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdmin(`/admin/elections/${id}/audit-log`);

  const election = await prisma.election.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      auditLogs: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!election) notFound();

  return (
    <div className="max-w-xl">
      <Link
        href={`/admin/elections/${id}`}
        className="mb-4 inline-flex items-center gap-1 text-sm font-bold text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {election.title}
      </Link>
      <h1 className="mb-6 flex items-center gap-2 font-extrabold text-2xl tracking-tight">
        <History className="h-6 w-6" /> 稽核紀錄
      </h1>

      <ElectionAuditLogTimeline logs={election.auditLogs} />
    </div>
  );
}

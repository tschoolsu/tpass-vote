import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, History } from "lucide-react";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { OfficeForm } from "@/components/admin/panels/OfficeForm";
import { OfficeEditLogTimeline } from "@/components/admin/panels/OfficeEditLogTimeline";
import type { OfficeMemberInput } from "@/app/admin/offices/actions";

export default async function OfficeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdmin(`/admin/offices/${id}`);

  const office = await prisma.office.findUnique({
    where: { id },
    include: { editLogs: { orderBy: { createdAt: "desc" } } },
  });
  if (!office) notFound();

  const members = Array.isArray(office.currentMembers)
    ? (office.currentMembers as unknown as OfficeMemberInput[])
    : [];

  return (
    <div className="max-w-xl">
      <Link href="/admin/offices" className="mb-4 inline-flex items-center gap-1 text-sm font-bold text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> 職務登記表
      </Link>
      <h1 className="font-extrabold text-2xl tracking-tight mb-6">編輯職務</h1>

      <OfficeForm
        mode="edit"
        officeId={office.id}
        initial={{
          title: office.title,
          members,
          isVacant: office.isVacant,
          startedAt: office.startedAt,
          note: office.note,
        }}
      />

      <div className="mt-10">
        <h2 className="mb-3 flex items-center gap-2 font-extrabold text-lg">
          <History className="h-5 w-5" /> 編輯記錄
        </h2>
        <OfficeEditLogTimeline logs={office.editLogs} />
      </div>
    </div>
  );
}

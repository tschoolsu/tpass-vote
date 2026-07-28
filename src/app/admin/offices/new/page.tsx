import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/guard";
import { OfficeForm } from "@/components/admin/panels/OfficeForm";

export default async function NewOfficePage() {
  await requireAdmin("/admin/offices/new");
  return (
    <div className="max-w-xl">
      <Link href="/admin/offices" className="mb-4 inline-flex items-center gap-1 text-sm font-bold text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> 職務登記表
      </Link>
      <h1 className="font-extrabold text-2xl tracking-tight mb-6">新增職務</h1>
      <OfficeForm mode="create" />
    </div>
  );
}

// 新增選舉：server 端撈職務清單（供「對應職務」下拉），互動兩步流程在 NewElectionClient。
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { NewElectionClient } from "./NewElectionClient";

export default async function NewElectionPage() {
  await requireAdmin("/admin/elections/new");
  const offices = await prisma.office.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } });
  return <NewElectionClient offices={offices} />;
}

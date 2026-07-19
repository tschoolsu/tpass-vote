// 開票已併入單頁工作台的「⑥開票」面板（直接嵌 TallyClient），這條路由只做轉址。
// actions.ts 保留：工作台的 TallyPanel/TallyClient 仍呼叫這裡的 sealElection/submitResults。
import { redirect } from "next/navigation";

export default async function TallyRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/admin/elections/${id}`);
}

// 候選人審核已併入單頁工作台的「②登記」面板，這條路由只做轉址，避免死路與舊連結斷裂。
// actions.ts 保留：工作台的 RegistrationPanel 仍呼叫這裡的 approveCandidate 等 action。
import { redirect } from "next/navigation";

export default async function CandidatesRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/admin/elections/${id}`);
}

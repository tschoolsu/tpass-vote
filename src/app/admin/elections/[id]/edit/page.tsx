// 編輯選舉已併入單頁工作台的「①設定」面板（檢視／編輯切換），這條路由只做轉址。
// actions.ts 保留：工作台的 SettingsPanel 仍呼叫這裡的 updateElection action。
import { redirect } from "next/navigation";

export default async function EditElectionRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/admin/elections/${id}`);
}

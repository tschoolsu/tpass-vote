// 名冊管理已併入單頁工作台的「①設定」面板，這條路由只做轉址，避免死路與舊連結斷裂。
// actions.ts 保留：工作台的 SettingsPanel 仍呼叫這裡的 importRoster/removeVoter。
import { redirect } from "next/navigation";

export default async function RosterRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/admin/elections/${id}`);
}

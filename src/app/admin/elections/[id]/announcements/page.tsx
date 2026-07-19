// 公告管理已併入單頁工作台的公告區塊（貫穿全程，法定三格＋一般公告＋已發布歷史），
// 這條路由只做轉址。actions.ts 保留：工作台的 AnnouncementEditor 仍呼叫這裡的
// saveAnnouncementDraft/publishAnnouncement。
import { redirect } from "next/navigation";

export default async function AnnouncementsRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/admin/elections/${id}`);
}

// 授權判斷（契約 v2「permissions claim」）：只讀 T-Pass 通行證上的 permissions 章，
// 不再自維護名單、不查 DB。角色（admin/moderator/ban/warning）統一在中央 auth panel 管。
import "server-only";
import { permOf, type TPassClaims } from "@/lib/tpass-auth";

// 超級管理員：role === "admin"（admin 隱含 moderator，見契約）。
export function isSuperAdmin(session: TPassClaims | null | undefined): boolean {
  return permOf(session).role === "admin";
}

// 一般管理員（含超管）：role 不是 default 就能管選舉。
export function isAdmin(session: TPassClaims | null | undefined): boolean {
  return permOf(session).role !== "default";
}

// 目前是否被警告（尚未過期）；回傳 reason/until 供 UI 顯示橫幅，非警告則回 null。
export function warningOf(
  session: TPassClaims | null | undefined,
): { reason?: string; until?: number } | null {
  const perm = permOf(session);
  if (perm.restriction !== "warning") return null;
  return { reason: perm.reason, until: perm.until };
}

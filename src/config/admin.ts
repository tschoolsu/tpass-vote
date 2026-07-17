// Admin 守門：auth 沒有角色概念，「誰能管選舉」全在這裡的消費端白名單決定。
//   超級管理員 = SUPER_ADMIN_EMAILS（env 種子，逗號分隔）—— 只有他們能管理名單。
//   一般管理員 = 超管 ∪ DB 的 Admin 表 —— 能管理選舉（開票私鑰持有者仍另外把關，見 AGENTS.md）。
import "server-only";
import { prisma } from "@/lib/db";

const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export function isSuperAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return SUPER_ADMIN_EMAILS.includes(email.toLowerCase());
}

// 是否為管理員（超管種子 或 DB 名單）。需查 DB，故為 async。
export async function isAdmin(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  if (isSuperAdmin(email)) return true;
  const found = await prisma.admin.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true },
  });
  return found !== null;
}

export { SUPER_ADMIN_EMAILS };

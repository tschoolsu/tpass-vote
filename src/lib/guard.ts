// Server 端守門小工具，供 server actions / route handlers 重用。
// 頁面/layout 的 UI 版 forbidden 由元件處理。
import "server-only";
import { redirect } from "next/navigation";
import { getSession, permOf, type TPassClaims } from "@/lib/tpass-auth";
import { isAdmin, isSuperAdmin } from "@/config/admin";
import { loginUrlFor, deniedUrlFor } from "@/config/auth";

export class ForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "ForbiddenError";
  }
}

export async function requireSession(returnPath = "/"): Promise<TPassClaims> {
  const session = await getSession();
  if (!session) redirect(loginUrlFor(returnPath));
  // ban（restriction=ban 尚未過期）：read=false，導去 auth 的 /denied 頁看原因。
  // 正常情況下 authorize 就會擋下不簽票，這裡是舊票在 TTL 內仍帶著 ban 前狀態時的第二道保險。
  if (!permOf(session).read) redirect(deniedUrlFor());
  return session;
}

export async function requireAdmin(returnPath = "/admin"): Promise<TPassClaims> {
  const session = await requireSession(returnPath);
  if (!isAdmin(session)) throw new ForbiddenError();
  return session;
}

export async function requireSuperAdmin(returnPath = "/admin"): Promise<TPassClaims> {
  const session = await requireSession(returnPath);
  if (!isSuperAdmin(session)) throw new ForbiddenError();
  return session;
}

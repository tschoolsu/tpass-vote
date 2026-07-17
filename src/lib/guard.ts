// Server 端守門小工具，供 server actions / route handlers 重用。
// 頁面/layout 的 UI 版 forbidden 由元件處理。
import "server-only";
import { redirect } from "next/navigation";
import { getSession, type TPassClaims } from "@/lib/tpass-auth";
import { isAdmin, isSuperAdmin } from "@/config/admin";
import { loginUrlFor } from "@/config/auth";

export class ForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "ForbiddenError";
  }
}

export async function requireSession(returnPath = "/"): Promise<TPassClaims> {
  const session = await getSession();
  if (!session) redirect(loginUrlFor(returnPath));
  return session;
}

export async function requireAdmin(returnPath = "/admin"): Promise<TPassClaims> {
  const session = await requireSession(returnPath);
  if (!(await isAdmin(session.email))) throw new ForbiddenError();
  return session;
}

export async function requireSuperAdmin(returnPath = "/admin"): Promise<TPassClaims> {
  const session = await requireSession(returnPath);
  if (!isSuperAdmin(session.email)) throw new ForbiddenError();
  return session;
}

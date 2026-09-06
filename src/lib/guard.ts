// Server 端守門小工具，供 server actions / route handlers 重用。
// 頁面/layout 的 UI 版 forbidden 由元件處理。
import "server-only";
import { redirect } from "next/navigation";
import type { TPassClaims } from "tpass-auth-js";
import { tpass, loginUrlFor, deniedUrlFor } from "@/config/auth";
import { isAdmin, isSuperAdmin } from "@/config/admin";

export class ForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "ForbiddenError";
  }
}

export async function requireSession(returnPath = "/"): Promise<TPassClaims> {
  const session = await tpass.getSession();
  if (!session) redirect(loginUrlFor(returnPath));
  // ban（restriction=ban 尚未過期）：read=false，導去 auth 的 /denied 頁看原因。
  // 正常情況下 authorize 就會擋下不簽票，這裡是舊票在 TTL 內仍帶著 ban 前狀態時的第二道保險。
  if (!tpass.permOf(session).read) redirect(deniedUrlFor());
  // auth 簽出的 email claim 不保證恆為小寫，這裡收斂成唯一的正規化點——
  // 經過 requireSession() 這條路徑的 session.email 都吃到同一份正規化值。
  // 例外：不強制登入的公開頁（如 e/[slug]/page.tsx）直接呼叫 tpass.getSession()，
  // 繞過這裡，若該頁要用 session.email 做 unique／比對，得自己正規化一次。
  return { ...session, email: session.email.trim().toLowerCase() };
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

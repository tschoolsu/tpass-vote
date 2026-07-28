// ★ T-Pass SSO 驗章（照抄 tpass-portal/src/lib/tpass-auth.ts 的參考實作・契約 v2）★
// 只靠 JWKS 公鑰在自己後端本地驗章認出使用者，全程不回呼 auth、不碰私鑰。
//
// 安全四鐵則（務必照做，缺一不可）：
//   1. 鎖 algorithms: ['EdDSA'] —— 不鎖會有 alg confusion 偽造風險（公鑰被當對稱密鑰）。
//   2. 檢查 issuer —— 確認票是「這個 auth」簽的。
//   3. 檢查 audience == tpass:<本服務id> —— 票是簽給「我」的；別的服務的 token 必須驗不過。
//   4. 檢查 exp（jose 預設會驗，別關掉）。
// 驗章只能在 server 端做（cookie 是 HttpOnly，瀏覽器 JS 拿不到）。
import "server-only";
import { cookies } from "next/headers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { authConfig } from "@/config/auth";

// 權限 claim 本體（契約 v2 Phase 6，跟 tpass-auth/src/lib/permissions/types.ts 同型別）。
export type Role = "admin" | "moderator" | "default";
export type Restriction = "none" | "warning" | "ban";

export interface PermissionEntry {
  read: boolean; // 必有。唯一必看欄位（= restriction !== "ban"）
  role: Role; // 必有。admin 隱含 moderator
  restriction?: Restriction; // 省略 = none
  reason?: string; // 只在 restriction !== "none" 時出現
  until?: number; // 選填 Unix 秒，管制到期自動解除
}

// T-Pass 通行證的身分內容（對接合約，詳見 tpass-auth/INTEGRATION.md）。
// vote 未上線，跳過 groups 相容層世代：只認 permissions，不留 role: string placeholder。
export interface TPassClaims {
  sub: string;
  email: string;
  name: string;
  // 授權本體（Phase 6）：此持有人在「本服務」的權限。一般服務 token 只含自己 serviceId 一把 key。
  permissions: Record<string, PermissionEntry>;
  exp: number;
}

// 安全預設（務必保留）：claim 缺 permissions、或沒有自己 serviceId 的 key
// → 一律當作「能看、一般使用者」，不因為 token 尚未升級 / 邊界情況就把人擋在外面。
const DEFAULT_PERMISSION: PermissionEntry = { read: true, role: "default" };

// 回本服務（config 的 serviceId）在這張通行證上的權限 entry。各層授權判斷的唯一入口。
export function permOf(session: TPassClaims | null | undefined): PermissionEntry {
  if (!session) return DEFAULT_PERMISSION;
  return session.permissions?.[authConfig.serviceId] ?? DEFAULT_PERMISSION;
}

// createRemoteJWKSet 內建記憶體快取 + 依 kid 選鑰 + 金鑰輪替時自動重抓。
const JWKS = createRemoteJWKSet(new URL(authConfig.jwksUrl));

// 驗一個 token。失敗（過期 / 竄改 / 錯 iss/aud / 錯演算法）一律回 null，不外拋。
export async function verifySession(
  token: string,
): Promise<TPassClaims | null> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      algorithms: ["EdDSA"],
      issuer: authConfig.issuer,
      audience: authConfig.serviceAudience,
    });
    return {
      sub: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      permissions: (payload.permissions as Record<string, PermissionEntry> | undefined) ?? {},
      exp: payload.exp as number,
    };
  } catch {
    return null;
  }
}

// 讀目前 session：看自己的 host-only cookie（v2）。
export async function getSession(): Promise<TPassClaims | null> {
  const token = (await cookies()).get(authConfig.ownCookieName)?.value;
  if (!token) return null;
  return verifySession(token);
}

// POST /api/auth/callback — 接收 auth 以 form_post 交付的 per-service token（契約 v2）。
// 驗章通過才寫進「本服務自己的」host-only cookie；token 全程不出現在 URL。
// 參考實作照抄自 tpass-form，只換 config import。
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "@/config/auth";
import { verifySession } from "@/lib/tpass-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const token = form.get("token");
  const next = String(form.get("next") ?? "/");
  if (typeof token !== "string" || !token) {
    return new NextResponse("Bad request", { status: 400 });
  }

  // 安全四鐵則驗章（aud = 本服務專屬）；驗不過一律 401，不留線索。
  const claims = await verifySession(token);
  if (!claims) return new NextResponse("Invalid token", { status: 401 });

  // next 只能是站內路徑（防 Open Redirect）。
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  const response = NextResponse.redirect(new URL(safeNext, authConfig.selfUrl), 303);
  response.cookies.set(authConfig.ownCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: authConfig.cookieSecure,
    path: "/",
    // cookie 壽命跟著 token 走，不多不少。
    maxAge: Math.max(0, claims.exp - Math.floor(Date.now() / 1000)),
    // 不設 domain → host-only：別的子網域收不到，這就是 v2 的隔離來源。
  });
  return response;
}

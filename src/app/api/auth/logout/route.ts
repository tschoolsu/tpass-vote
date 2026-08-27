// POST /api/auth/logout — 兩段式登出（契約 v2）：先清自己的 host-only cookie，
// 再回一頁自動送出的 form POST 到 auth 清登入態，auth 再導回本服務。
// 表單可帶站內路徑 next（登出後回到指定頁，切換帳號用）。兩段都在 tpass-auth-js 裡。
import { tpass } from "@/config/auth";

export const runtime = "nodejs";

export const POST = tpass.logoutHandler;

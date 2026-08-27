// POST /api/auth/callback — 接收 auth 以 form_post 交付的 per-service token（契約 v2）。
// 驗章通過才寫進「本服務自己的」host-only cookie；token 全程不出現在 URL。
// 內容（驗章四鐵則、Open Redirect 防線、cookie 屬性）全在 tpass-auth-js。
import { tpass } from "@/config/auth";

export const runtime = "nodejs";

export const POST = tpass.callbackHandler;

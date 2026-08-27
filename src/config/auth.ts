// T-Vote（consumer）SSO 設定中心。只讀 env，集中管理「對接 auth 所需的最少資訊」。
// 邊界：只需要 JWKS 公鑰來源與幾個 URL，絕不碰 auth 私鑰 / arctic / OAuth。
//
// 驗章本體在套件 tpass-auth-js（C1，2026-08-27）——這裡只負責把 env 綁上去。
// 要改驗章邏輯就去那個 repo 改，不要在這裡復活一份手抄副本。
import "server-only";
import { configFromEnv, createTpassNextAuth } from "tpass-auth-js/next";

// SSO 那六顆 env 的必填檢查在套件裡（缺了直接 throw）。
export const tpass = createTpassNextAuth(configFromEnv("VOTE_SELF_URL"));

// 本服務自己的必填 env（不屬於 SSO 合約，所以套件不管）。
const REQUIRED = [
  "PORTAL_URL",
] as const;

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(
    `[config/auth] 缺少必填環境變數：${missing.join(", ")}（請檢查 .env.local）`,
  );
}

// 登入回跳路徑可帶站內路徑，組成 authorize 入口（契約 v2）。
export function loginUrlFor(returnPath = "/"): string {
  return tpass.loginUrl(returnPath);
}

// reason 絕不放進 query string（auth 的 /denied 自己憑 session 在 server side 重查）。
export function deniedUrlFor(): string {
  return tpass.deniedUrl();
}

export const authConfig = {
  loginUrl: tpass.loginUrl("/"),
  // 登出走自己的 route：先清自己的 cookie，再鏈到 auth 清登入態。
  logoutUrl: tpass.logoutUrl,
  selfUrl: tpass.selfUrl,
  serviceId: tpass.serviceId,
  // 門戶大廳連結。env 驅動，絕不寫死網域。
  portalUrl: process.env.PORTAL_URL!,
} as const;

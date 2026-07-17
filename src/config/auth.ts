// tpass-vote（consumer）SSO 設定中心。只讀 env，集中管理「對接 auth 所需的最少資訊」。
// 邊界：只需要 JWKS 公鑰來源與幾個 URL，絕不碰 auth 私鑰 / arctic / OAuth。
import "server-only";

const REQUIRED = [
  "AUTH_JWKS_URL",
  "AUTH_AUTHORIZE_URL",
  "AUTH_LOGOUT_URL",
  "VOTE_SELF_URL",
  "PORTAL_URL",
  "TPASS_SERVICE_ID",
  "JWT_ISSUER",
] as const;

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(
    `[config/auth] 缺少必填環境變數：${missing.join(", ")}（請檢查 .env.local）`,
  );
}

const self = process.env.VOTE_SELF_URL!;
const serviceId = process.env.TPASS_SERVICE_ID!;

// 登入回跳路徑可帶站內路徑（例如剛要看的那場選舉），組成 authorize 入口（契約 v2）。
export function loginUrlFor(returnPath = "/"): string {
  const u = new URL(process.env.AUTH_AUTHORIZE_URL!);
  u.searchParams.set("service", serviceId);
  u.searchParams.set("redirect_uri", `${self}/api/auth/callback`);
  u.searchParams.set("next", returnPath);
  return u.toString();
}

export const authConfig = {
  jwksUrl: process.env.AUTH_JWKS_URL!,
  loginUrl: loginUrlFor("/"),
  // 登出走自己的 route：先清自己的 cookie，再鏈到 auth 清登入態。
  logoutUrl: `${self}/api/auth/logout`,
  authLogoutUrl: process.env.AUTH_LOGOUT_URL!,
  selfUrl: self,
  serviceId,
  // 回門戶大廳的網址（navbar 按鈕用）。env 驅動，絕不寫死網域。
  portalUrl: process.env.PORTAL_URL!,
  issuer: process.env.JWT_ISSUER!,
  // v2：本服務專屬 audience——別的服務的 token 在這裡驗不過（爆炸半徑隔離）。
  serviceAudience: `tpass:${serviceId}`,
  // v2：本服務自己的 host-only cookie（不設 Domain，別的子網域收不到）。
  ownCookieName: "tpass_token",
  cookieSecure: self.startsWith("https://"),
} as const;

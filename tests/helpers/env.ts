// 整合測試的固定設定：所有 port、網址、資料庫都集中在這裡，測試檔不自己拼字串。
// 這些值同時餵給 vitest 的 globalSetup（起 JWKS stub 與 next server）與各測試檔。

// 平行 worktree 各自跑整合／壓測時，用 TEST_PORT_BASE 與 TEST_DATABASE_URL 錯開；預設值與單一 checkout 相同。
const PORT_BASE = Number(process.env.TEST_PORT_BASE ?? 39000);
export const TEST_PORTS = {
  jwks: PORT_BASE + 12,
  app: PORT_BASE + 66,
} as const;

export const JWKS_URL = `http://127.0.0.1:${TEST_PORTS.jwks}/.well-known/jwks.json`;
export const APP_URL = `http://127.0.0.1:${TEST_PORTS.app}`;
export const AUTH_ORIGIN = `http://127.0.0.1:${TEST_PORTS.jwks}`;

// 測試 server 的 pid 與 log 落地位置（.next 已被 gitignore）。壓力測試靠它盯記憶體與存活。
export const APP_PID_FILE = ".next/.test-app.pid";
export const APP_LOG_FILE = ".next/.test-app.log";

export const TEST_ISSUER = "https://auth.test.local";
export const SERVICE_ID = "vote";
export const AUDIENCE = `tpass:${SERVICE_ID}`;
export const COOKIE_NAME = "tpass_token";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://t_vote@localhost:5432/t_vote_test";

/** 跑 app 與測試 process 都要吃的一整包 env。權限不在 env——角色寫在 token 的 permissions claim。 */
export function testEnv(): Record<string, string> {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    TPASS_SERVICE_ID: SERVICE_ID,
    JWT_ISSUER: TEST_ISSUER,
    AUTH_JWKS_URL: JWKS_URL,
    AUTH_AUTHORIZE_URL: `${AUTH_ORIGIN}/authorize`,
    AUTH_LOGOUT_URL: `${AUTH_ORIGIN}/logout`,
    VOTE_SELF_URL: APP_URL,
    PORTAL_URL: `${AUTH_ORIGIN}/portal`,
    STORAGE_DRIVER: "local",
  };
}

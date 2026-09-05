// k6 這條路徑用的 port／env，跟 tests/helpers/env.ts 分開一組，
// 因為這裡起的 server 要活過 vitest process 本身（給獨立的 k6 process 打）。
export const K6_TEST_PORTS = {
  jwks: 39013,
  app: 39068,
} as const;

export const K6_JWKS_URL = `http://127.0.0.1:${K6_TEST_PORTS.jwks}/.well-known/jwks.json`;
export const K6_APP_URL = `http://127.0.0.1:${K6_TEST_PORTS.app}`;
export const K6_AUTH_ORIGIN = `http://127.0.0.1:${K6_TEST_PORTS.jwks}`;

export const K6_TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://t_vote@localhost:5432/t_vote_test";

export function k6TestEnv(): Record<string, string> {
  return {
    DATABASE_URL: K6_TEST_DATABASE_URL,
    TPASS_SERVICE_ID: "vote",
    JWT_ISSUER: "https://auth.test.local",
    AUTH_JWKS_URL: K6_JWKS_URL,
    AUTH_AUTHORIZE_URL: `${K6_AUTH_ORIGIN}/authorize`,
    AUTH_LOGOUT_URL: `${K6_AUTH_ORIGIN}/logout`,
    VOTE_SELF_URL: K6_APP_URL,
    PORTAL_URL: `${K6_AUTH_ORIGIN}/portal`,
    STORAGE_DRIVER: "local",
  };
}

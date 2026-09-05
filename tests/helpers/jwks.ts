// JWKS stub ＋ 測試 token 簽發。
//
// 整合測試需要「auth 簽發的通行證」。與其啟動整個 tpass-auth（連 Google、連它自己的 DB），
// 這裡自架一個只吐公鑰的 JWKS 端點，並用配對的測試私鑰簽 token。
// 對 tpass-auth-js 而言這與真 auth 無異——它只認 JWKS、issuer、audience、EdDSA、exp。
//
// ⚠️ 用的是 tests/helpers/test-keys.ts 的測試金鑰，auth 的真私鑰全程不參與。
import { createServer, type Server } from "node:http";
import { SignJWT, importJWK, type JWK } from "jose";
import { TEST_PRIVATE_JWK, TEST_PUBLIC_JWK } from "./test-keys";
import { AUDIENCE, SERVICE_ID, TEST_ISSUER, TEST_PORTS } from "./env";

export type TestRole = "admin" | "moderator" | "default";

export interface TestIdentity {
  sub?: string;
  email: string;
  name?: string;
  role?: TestRole;
  /** false＝被 ban，requireSession 應導向 /denied。 */
  read?: boolean;
  restriction?: "none" | "warning" | "ban";
  entryYear?: number | null;
  /** 相對現在的有效秒數；給負數就是過期票。 */
  ttlSeconds?: number;
  /** 覆寫 audience，用來測「別的服務的票不能拿來用」。 */
  audience?: string;
  /** 覆寫 issuer，用來測 issuer 檢查。 */
  issuer?: string;
  /** 改用另一把私鑰簽，用來測「偽造簽發者」。 */
  privateJwk?: JWK;
}

/** 簽一張測試通行證。預設是有效期 1 小時的一般使用者。 */
export async function signTestToken(id: TestIdentity): Promise<string> {
  const ttl = id.ttlSeconds ?? 3600;
  const now = Math.floor(Date.now() / 1000);
  const key = await importJWK((id.privateJwk ?? TEST_PRIVATE_JWK) as JWK, "EdDSA");

  return new SignJWT({
    email: id.email,
    name: id.name ?? id.email.split("@")[0],
    permissions: {
      [SERVICE_ID]: {
        read: id.read ?? true,
        role: id.role ?? "default",
        ...(id.restriction && id.restriction !== "none" ? { restriction: id.restriction } : {}),
      },
    },
    entryYear: id.entryYear ?? null,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: TEST_PRIVATE_JWK.kid })
    .setSubject(id.sub ?? `sub-${id.email}`)
    .setIssuer(id.issuer ?? TEST_ISSUER)
    .setAudience(id.audience ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(key);
}

/** 組成可以直接放進 Cookie header 的字串。 */
export function cookieHeader(token: string, name = "tpass_token"): string {
  return `${name}=${token}`;
}

/** 啟動 JWKS stub；回傳關閉函式。預設監聽 TEST_PORTS.jwks，k6 前置腳本用別的 port 時可覆寫。 */
export function startJwksServer(
  port: number = TEST_PORTS.jwks,
): Promise<{ close: () => Promise<void>; server: Server }> {
  const body = JSON.stringify({ keys: [TEST_PUBLIC_JWK] });
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/.well-known/jwks.json")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    // authorize / logout / denied 只是導向目標，測試不會真的跟進去。
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("stub");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

// 獨立跑的 JWKS stub，給 k6 壓測用。跟 tests/helpers/jwks.ts 邏輯一樣，
// 只是抽成一支能單獨啟動、脫離 vitest process 存活的小 server。
// 金鑰跟 tests/helpers/test-keys.ts 完全一致——這是版控裡公開的測試金鑰，不是機密。
import { createServer } from "node:http";

const TEST_PUBLIC_JWK = {
  crv: "Ed25519",
  x: "FqTSVLGWqvnLO2eG52mRA3U-LBOu8c45c4t7XqdEU4o",
  kty: "OKP",
  kid: "tvote-test-key",
  alg: "EdDSA",
  use: "sig",
};

const port = Number(process.env.JWKS_PORT ?? 39013);
const body = JSON.stringify({ keys: [TEST_PUBLIC_JWK] });

const server = createServer((req, res) => {
  if (req.url?.startsWith("/.well-known/jwks.json")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("stub");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[jwks-server] listening on 127.0.0.1:${port}`);
});

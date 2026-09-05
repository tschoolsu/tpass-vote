// 從 HTTP 層打 Next 16 的 server action——走真正的 wire protocol，而不是在 vitest process
// 內直接 `import { castBallot }` 呼叫。壓測要盯的是「伺服器」在投票尖峰的行為（RSS、連線池、
// CSRF），in-process 呼叫走的是測試 process 自己的 Prisma pool，量不到這些。
//
// Next 把每個 server action 編成一個 actionId，記在 build 產物
// `.next/server/server-reference-manifest.json`。這個 id 每次 build 都會變（是檔案內容
// 的 hash），所以這裡一律 runtime 讀檔，不准寫死。
//
// 該檔案的結構（2026-09 實測，Next 16.3.3 + Turbopack production build）：
//   {
//     node: {
//       "<actionId>": {
//         workers: { "<Next 內部路由，如 app/e/[slug]/vote/page>": { moduleId, async, codeHash } },
//         filename: "src/app/.../actions.ts",
//         exportedName: "castBallot",
//       },
//       ...
//     },
//     edge: {},
//     encryptionKey: "...",   // 給 bound closure 參數加密用的，castBallot 這類直接傳參數的
//                             // action 用不到，這裡不需要處理。
//   }
//
// 客戶端打 server action 的協定（見
// node_modules/next/dist/server/app-render/action-handler.js 與
// node_modules/next/dist/server/lib/server-action-request-meta.js）：
//   - method 一律 POST，打到該 action 所屬頁面的實際路由（同一個 worker 內就地執行，
//     不必倚賴 selectWorkerForForwarding 的轉發）。
//   - header `Next-Action: <actionId>` 是唯一讓 isFetchAction 判定為真的條件。
//   - `Content-Type` 只要不是 `multipart/form-data` 或
//     `application/x-www-form-urlencoded` 就會走「非 multipart」分支；React 真正的
//     client 用 `text/plain;charset=UTF-8`，這裡照抄。
//   - CSRF（action-handler.js 的 originHost 比對）：`Origin` header 的 host 必須等於
//     請求的 `Host`（或 `X-Forwarded-Host`）header。這個專案的 next.config.ts 沒有設
//     `experimental.serverActions.allowedOrigins`，所以只有同源才會過，其餘一律 500。
//   - body：非 multipart 分支把整包 body 讀成字串交給 React 的 decodeReply
//     （react-server-dom-webpack/server.node）。對純 JSON 可序列化、不含 bound closure
//     的參數（castBallot(slug, ciphertext) 兩個都是字串），這個字串就是
//     `JSON.stringify(args)`——不必真的引入 React 的 encodeReply。
import { readFileSync } from "node:fs";
import path from "node:path";
import { APP_URL } from "./env";
import { signTestToken, cookieHeader, type TestIdentity } from "./jwks";

interface ManifestEntry {
  workers: Record<string, unknown>;
  filename: string;
  exportedName: string;
}

interface ServerReferenceManifest {
  node: Record<string, ManifestEntry>;
  edge: Record<string, ManifestEntry>;
}

function manifestPath(): string {
  return path.join(process.cwd(), ".next", "server", "server-reference-manifest.json");
}

// manifest 在一次 build 內不會變，module-level 快取一份，不然壓測 jobs.map(callAction)
// 會在任何 fetch 發出去之前，把幾千次 readFileSync + JSON.parse 同步跑完，反而拖慢
// 「瞬間併發」這件事本身要量的東西。
let manifestCache: ServerReferenceManifest | null = null;

function readManifest(): ServerReferenceManifest {
  if (manifestCache) return manifestCache;
  const p = manifestPath();
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    throw new Error(
      `讀不到 ${p}——action-http 打的是 production build 的 server action，請先 \`pnpm build\`。`,
    );
  }
  manifestCache = JSON.parse(raw) as ServerReferenceManifest;
  return manifestCache;
}

/** 把 Next 內部路由字串（如 "app/e/[slug]/vote/page"）拆成片段，去掉 app/ 前綴與尾端的 page|route。 */
function workerSegments(worker: string): string[] {
  return worker
    .replace(/^app\//, "")
    .replace(/\/(page|route)$/, "")
    .split("/")
    .filter(Boolean);
}

/** routePath（真的 URL path，如 "/e/burst-election/vote"）是否對得上這個內部路由模式。
 * 動態片段（"[slug]"）接受任何值，其餘片段要求逐字相等。 */
function routeMatchesWorker(routePath: string, worker: string): boolean {
  const routeSegments = routePath.split("/").filter(Boolean);
  const pattern = workerSegments(worker);
  if (routeSegments.length !== pattern.length) return false;
  return pattern.every((seg, i) => seg.startsWith("[") || seg === routeSegments[i]);
}

/** 依匯出名稱（可選路由提示消歧義）找出這次 build 產物裡的 actionId。 */
export function resolveAction(
  exportedName: string,
  routeHint?: string,
): { id: string; routes: string[] } {
  const manifest = readManifest();
  for (const [id, entry] of Object.entries(manifest.node)) {
    if (entry.exportedName !== exportedName) continue;
    const routes = Object.keys(entry.workers);
    if (routeHint && !routes.some((w) => routeMatchesWorker(routeHint, w))) continue;
    return { id, routes };
  }
  throw new Error(
    `在 ${manifestPath()} 找不到 action「${exportedName}」` +
      (routeHint ? `（路由提示：${routeHint}）` : "") +
      "——確定名稱對、build 是新的嗎？",
  );
}

export interface CallActionOptions {
  /** 用這個身分簽一張測試通行證放進 Cookie；傳 null／不傳＝不帶 Cookie（未登入）。 */
  identity?: TestIdentity | null;
  /** 直接指定 Cookie header 的值，蓋過 identity（測畸形 cookie 之類的場合用）。 */
  cookie?: string;
  /** 覆寫 Origin header，用來測 CSRF；預設等於 APP_URL 的 origin（同源，會通過）。 */
  origin?: string;
}

/** 對 `${APP_URL}${routePath}` 發一個真正的 server action HTTP 請求。
 * 不解析 Flight 回應本體——呼叫端靠狀態碼＋回 DB 查副作用斷言就夠了。 */
export async function callAction(
  exportedName: string,
  routePath: string,
  args: unknown[],
  opts: CallActionOptions = {},
): Promise<{ status: number; text: string }> {
  const { id } = resolveAction(exportedName, routePath);

  const headers: Record<string, string> = {
    "Next-Action": id,
    "Content-Type": "text/plain;charset=UTF-8",
    Accept: "text/x-component",
    Origin: opts.origin ?? new URL(APP_URL).origin,
  };
  const cookie =
    opts.cookie ??
    (opts.identity != null ? cookieHeader(await signTestToken(opts.identity)) : undefined);
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(`${APP_URL}${routePath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
    redirect: "manual",
  });
  return { status: res.status, text: await res.text() };
}

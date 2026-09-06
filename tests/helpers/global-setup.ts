// 整合測試的全域前置：起 JWKS stub，並用 production build 起一個真的 vote server。
//
// - JWKS stub 讓「測試 process 內直接呼叫 server action」與「HTTP 黑箱測試」共用同一組金鑰。
// - HTTP server 跑的是 `next start`（不是 dev），黑箱與壓力測試才有意義；env 用注入的，
//   @next/env 不會覆蓋已存在的 process.env，所以它連的是測試資料庫而非開發庫
//   （tests/integration/http.test.ts 開頭還會再探測一次確認）。
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startJwksServer } from "./jwks";
import { APP_LOG_FILE, APP_PID_FILE, APP_URL, TEST_PORTS, testEnv } from "./env";

let jwks: { close: () => Promise<void> } | null = null;
let app: ChildProcess | null = null;

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`等 ${url} 逾時：${String(lastError)}`);
}

export async function setup() {
  jwks = await startJwksServer();

  const buildId = path.join(process.cwd(), ".next", "BUILD_ID");
  if (!existsSync(buildId)) {
    throw new Error("找不到 .next/BUILD_ID：整合測試打的是 production build，請先 `pnpm build`");
  }

  app = spawn(
    "node",
    [path.join("node_modules", "next", "dist", "bin", "next"), "start", "-p", String(TEST_PORTS.app), "-H", "127.0.0.1"],
    {
      cwd: process.cwd(),
      // 固定 TZ=Etc/UTC：正式主機時區就是 UTC。開發機常是 Asia/Taipei，跟 SITE_TIMEZONE
      // 剛好同值，若不強制 server 用 UTC 起，時區相關的迴歸（D2）在開發機上永遠測不出來
      // ——非要人記得手動 export TZ=Etc/UTC 才會紅，這道防線形同虛設（見稽核附件）。
      env: { ...process.env, ...testEnv(), NODE_ENV: "production", TZ: "Etc/UTC" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // 壓力測試要盯 server 的記憶體與存活狀態（2026-09-02 事故的根因之一就是
  // 記憶體上限被觸發後不斷重啟），所以把 pid 與 log 落到檔案供測試讀取。
  writeFileSync(APP_PID_FILE, String(app.pid ?? ""), "utf8");
  const logs: string[] = [];
  const record = (d: unknown) => {
    logs.push(String(d));
    appendFileSync(APP_LOG_FILE, String(d));
  };
  writeFileSync(APP_LOG_FILE, "", "utf8");
  app.stdout?.on("data", record);
  app.stderr?.on("data", record);
  app.once("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[global-setup] next start 結束（code=${code}）：\n${logs.join("")}`);
    }
  });

  try {
    await waitFor(`${APP_URL}/`, 60_000);
  } catch (e) {
    console.error(`[global-setup] server 起不來：\n${logs.join("")}`);
    throw e;
  }
}

export async function teardown() {
  app?.kill("SIGTERM");
  await jwks?.close();
}

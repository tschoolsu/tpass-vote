// 給 k6 用的長駐 server：起 JWKS stub + `next start` production server，
// 兩個都用 detached child process，這支腳本自己結束後它們還活著。
// 用法：node tests/k6/start-server.mjs start   # 起
//       node tests/k6/start-server.mjs stop    # 關
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PID_FILE = path.join(ROOT, "tests/k6/data/.server-pids.json");
const JWKS_PORT = 39013;
const APP_PORT = 39068;

const env = {
  ...process.env,
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://t_vote@localhost:5432/t_vote_test",
  TPASS_SERVICE_ID: "vote",
  JWT_ISSUER: "https://auth.test.local",
  AUTH_JWKS_URL: `http://127.0.0.1:${JWKS_PORT}/.well-known/jwks.json`,
  AUTH_AUTHORIZE_URL: `http://127.0.0.1:${JWKS_PORT}/authorize`,
  AUTH_LOGOUT_URL: `http://127.0.0.1:${JWKS_PORT}/logout`,
  VOTE_SELF_URL: `http://127.0.0.1:${APP_PORT}`,
  PORTAL_URL: `http://127.0.0.1:${JWKS_PORT}/portal`,
  STORAGE_DRIVER: "local",
  NODE_ENV: "production",
};

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
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

function stop() {
  if (!existsSync(PID_FILE)) {
    console.log("[start-server] 沒有 pid 檔，可能本來就沒在跑");
    return;
  }
  const { jwksPid, appPid } = JSON.parse(readFileSync(PID_FILE, "utf8"));
  for (const pid of [jwksPid, appPid]) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`[start-server] 已送出 SIGTERM 給 pid ${pid}`);
    } catch (e) {
      console.log(`[start-server] pid ${pid} 已經不在了（${e.message}）`);
    }
  }
  unlinkSync(PID_FILE);
}

async function start() {
  const jwks = spawn("node", [path.join(ROOT, "tests/k6/jwks-server.mjs")], {
    cwd: ROOT,
    env: { ...env, JWKS_PORT: String(JWKS_PORT) },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  jwks.unref();

  const app = spawn(
    "node",
    [path.join("node_modules", "next", "dist", "bin", "next"), "start", "-p", String(APP_PORT), "-H", "127.0.0.1"],
    {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  app.unref();

  writeFileSync(PID_FILE, JSON.stringify({ jwksPid: jwks.pid, appPid: app.pid }), "utf8");

  await waitFor(`http://127.0.0.1:${JWKS_PORT}/.well-known/jwks.json`, 10_000);
  await waitFor(`http://127.0.0.1:${APP_PORT}/`, 60_000);
  console.log(`[start-server] JWKS pid=${jwks.pid} on :${JWKS_PORT}・App pid=${app.pid} on :${APP_PORT}`);
}

const cmd = process.argv[2];
if (cmd === "start") await start();
else if (cmd === "stop") stop();
else {
  console.error("用法：node tests/k6/start-server.mjs start|stop");
  process.exit(1);
}

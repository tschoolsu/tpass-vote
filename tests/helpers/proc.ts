// 盯著測試 server 的 process：記憶體與存活。
// 2026-09-02 事故的根因之一是 pm2 的 max_memory_restart 被合法觸發後把上限記成 0，
// 從此每 30 秒重啟一次。要避免重演，壓力測試就得知道「灌爆時 RSS 到哪裡」。
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { APP_LOG_FILE, APP_PID_FILE } from "./env";

export function appPid(): number | null {
  if (!existsSync(APP_PID_FILE)) return null;
  const raw = readFileSync(APP_PID_FILE, "utf8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** server process 的 RSS（MB）；讀不到回 null。 */
export function appRssMb(): number | null {
  const pid = appPid();
  if (pid === null) return null;
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    const kb = Number(out.trim());
    return Number.isFinite(kb) ? Math.round((kb / 1024) * 10) / 10 : null;
  } catch {
    return null;
  }
}

export function appAlive(): boolean {
  const pid = appPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function appLog(): string {
  return existsSync(APP_LOG_FILE) ? readFileSync(APP_LOG_FILE, "utf8") : "";
}

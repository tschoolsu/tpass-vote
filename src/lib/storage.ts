// 物件儲存抽象層（env 驅動，可換供應商）。照抄 tpass-form/src/lib/storage.ts。
//   driver=local：寫到本機 ./.uploads（本機 demo 用；serverless 不持久）。
//   driver=s3   ：S3 相容（含 Supabase Storage 的 S3 endpoint）。v1 預留接口，未接 SDK 前會明確報錯。
// 不把供應商寫死在呼叫端——上線只改 .env.local。
import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { customAlphabet } from "nanoid";

const DRIVER = process.env.STORAGE_DRIVER ?? "local";
const LOCAL_DIR = path.join(process.cwd(), ".uploads");
const keyId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 20);

export function newStorageKey(): string {
  return keyId();
}

export async function putObject(
  key: string,
  data: Buffer,
  _contentType: string,
): Promise<void> {
  if (DRIVER === "local") {
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_DIR, sanitize(key)), data);
    return;
  }
  throw new Error(
    `[storage] driver "${DRIVER}" 尚未實作上傳。請改用 local，或在此接上 S3/Supabase SDK。`,
  );
}

export async function getObject(key: string): Promise<Buffer | null> {
  if (DRIVER === "local") {
    try {
      return await fs.readFile(path.join(LOCAL_DIR, sanitize(key)));
    } catch {
      return null;
    }
  }
  throw new Error(`[storage] driver "${DRIVER}" 尚未實作下載。`);
}

export async function deleteObject(key: string): Promise<void> {
  if (DRIVER === "local") {
    await fs.rm(path.join(LOCAL_DIR, sanitize(key)), { force: true });
    return;
  }
  throw new Error(`[storage] driver "${DRIVER}" 尚未實作刪除。`);
}

// key 只允許英數，擋路徑穿越。
function sanitize(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "");
}

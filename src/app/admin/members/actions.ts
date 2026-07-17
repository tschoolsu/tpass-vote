"use server";

// 選委會成員（管理員）名單管理（只有超管能動）。auth 沒有角色，這份白名單就是「誰能管選舉」的真相。
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/guard";
import { isSuperAdmin } from "@/config/admin";
import { prisma } from "@/lib/db";

export interface MemberResult {
  ok: boolean;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function addAdminAction(
  _prev: MemberResult | null,
  formData: FormData,
): Promise<MemberResult> {
  const session = await requireSuperAdmin("/admin/members");
  const raw = formData.get("email");
  const email = (typeof raw === "string" ? raw : "").trim().toLowerCase();

  if (!EMAIL_RE.test(email)) return { ok: false, error: "請輸入有效的電子郵件。" };
  if (isSuperAdmin(email)) return { ok: false, error: "這個帳號已是種子超管。" };

  const exists = await prisma.admin.findUnique({ where: { email }, select: { id: true } });
  if (exists) return { ok: false, error: "這個帳號已在名單中。" };

  await prisma.admin.create({ data: { email, addedBy: session.email } });
  revalidatePath("/admin/members");
  return { ok: true };
}

export async function removeAdminAction(formData: FormData): Promise<void> {
  await requireSuperAdmin("/admin/members");
  const id = formData.get("id");
  if (typeof id === "string") {
    await prisma.admin.delete({ where: { id } }).catch(() => {});
  }
  revalidatePath("/admin/members");
}

// 批次貼上匯入：格式就是純 email，一行一個。
function parseEmails(raw: string): string[] {
  return [...new Set(raw.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean))];
}

export type BulkRowStatus = "new" | "already-admin" | "invalid";

export interface BulkPreviewRow {
  email: string;
  status: BulkRowStatus;
}

export interface BulkPreviewResult {
  ok: boolean;
  error?: string;
  rawText?: string;
  rows?: BulkPreviewRow[];
  newCount?: number;
}

export async function previewBulkAddAction(
  _prev: BulkPreviewResult | null,
  formData: FormData,
): Promise<BulkPreviewResult> {
  await requireSuperAdmin("/admin/members");
  const rawText = String(formData.get("rawText") ?? "");
  const emails = parseEmails(rawText);
  if (emails.length === 0) return { ok: false, error: "請貼上至少一個 email。" };

  const existing = await prisma.admin.findMany({
    where: { email: { in: emails } },
    select: { email: true },
  });
  const existingSet = new Set(existing.map((a) => a.email));

  const rows: BulkPreviewRow[] = emails.map((email) => {
    if (!EMAIL_RE.test(email)) return { email, status: "invalid" };
    if (isSuperAdmin(email) || existingSet.has(email)) return { email, status: "already-admin" };
    return { email, status: "new" };
  });

  return { ok: true, rawText, rows, newCount: rows.filter((r) => r.status === "new").length };
}

export interface BulkCommitResult {
  ok: boolean;
  error?: string;
  added?: number;
  skipped?: number;
}

export async function commitBulkAddAction(
  _prev: BulkCommitResult | null,
  formData: FormData,
): Promise<BulkCommitResult> {
  const session = await requireSuperAdmin("/admin/members");
  const rawText = String(formData.get("rawText") ?? "");
  // 不信任 client 端預覽結果：用同一份原始文字重新 parse，避免 TOCTOU。
  const emails = parseEmails(rawText);
  if (emails.length === 0) return { ok: false, error: "沒有可匯入的內容。" };

  const toAdd = emails.filter((email) => EMAIL_RE.test(email) && !isSuperAdmin(email));
  const result = await prisma.admin.createMany({
    data: toAdd.map((email) => ({ email, addedBy: session.email })),
    skipDuplicates: true,
  });

  revalidatePath("/admin/members");
  return { ok: true, added: result.count, skipped: toAdd.length - result.count };
}

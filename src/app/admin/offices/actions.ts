"use server";
// 職務登記表的手動維護（新增／編輯）。每次寫入都留一筆 OfficeEditLog（誰、何時、改了什麼）。
// sourceElectionId / termValidCount 不開放手動改（那是罷免門檻母數，由選舉公告自動落地），
// 避免選委手滑破壞 2/5 門檻。自動落地邏輯見 src/lib/office-upsert.ts。
import { revalidatePath } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { buildDiff } from "@/lib/office-upsert";
import { parseDatetimeLocalInTimeZone } from "@/app/admin/elections/election-schema";
import { SITE_TIMEZONE } from "@/config/site";

export interface OfficeMemberInput {
  name: string;
  email?: string;
  grade?: string;
}

export interface OfficeInput {
  title: string;
  members: OfficeMemberInput[];
  isVacant: boolean;
  startedAt: string | null; // "YYYY-MM-DD" 或 null
  note: string | null;
}

export type OfficeActionResult = { ok: true; officeId: string } | { ok: false; error: string };

function cleanMembers(members: OfficeMemberInput[]): OfficeMemberInput[] {
  return members
    .map((m) => ({
      name: m.name.trim(),
      email: m.email?.trim() || undefined,
      grade: m.grade?.trim() || undefined,
    }))
    .filter((m) => m.name !== "");
}

// <input type="date"> 給的是「YYYY-MM-DD」牆上日期，選委腦中想的是台北時間的那一天。
// new Date(v) 會把它當 UTC 午夜解讀（ECMA-262 的 date-only 字串規則），主機 TZ=UTC 時
// 存進去的瞬間會早了 8 小時，變成台北時間前一天 16:00——跟 election-schema.ts 的
// datetime-local 是同一類 bug，一併借用它已驗證過的 SITE_TIMEZONE 解析。
function parseStartedAt(v: string | null): Date | null {
  if (!v) return null;
  const d = parseDatetimeLocalInTimeZone(`${v}T00:00`, SITE_TIMEZONE);
  return Number.isNaN(d.getTime()) ? null : d;
}

function validate(input: OfficeInput): { members: OfficeMemberInput[]; startedAt: Date | null } | { error: string } {
  const title = input.title.trim();
  if (title === "") return { error: "請填寫職務名稱" };
  const members = cleanMembers(input.members);
  if (!input.isVacant && members.length === 0) {
    return { error: "非從缺的職務至少要有一位現任學生（或勾選「從缺」）" };
  }
  return { members, startedAt: parseStartedAt(input.startedAt) };
}

export async function createOffice(input: OfficeInput): Promise<OfficeActionResult> {
  const admin = await requireAdmin("/admin/offices");
  const v = validate(input);
  if ("error" in v) return { ok: false, error: v.error };
  const title = input.title.trim();
  const note = input.note?.trim() || null;

  const office = await prisma.$transaction(async (tx) => {
    const created = await tx.office.create({
      data: {
        title,
        currentMembers: v.members as unknown as Prisma.InputJsonValue,
        isVacant: input.isVacant,
        startedAt: input.isVacant ? null : v.startedAt,
        note,
      },
    });
    await tx.officeEditLog.create({
      data: {
        officeId: created.id,
        editorEmail: admin.email,
        action: "manual_create",
        summary: `手動建立職務「${title}」`,
        diff: buildDiff({
          title: [null, title],
          currentMembers: [null, v.members],
          isVacant: [null, input.isVacant],
          startedAt: [null, v.startedAt?.toISOString() ?? null],
          note: [null, note],
        }) as Prisma.InputJsonValue,
      },
    });
    return created;
  }, { timeout: 10_000 });

  revalidatePath("/admin/offices");
  return { ok: true, officeId: office.id };
}

export async function updateOffice(id: string, input: OfficeInput): Promise<OfficeActionResult> {
  const admin = await requireAdmin(`/admin/offices/${id}`);
  const v = validate(input);
  if ("error" in v) return { ok: false, error: v.error };
  const title = input.title.trim();
  const note = input.note?.trim() || null;
  const startedAt = input.isVacant ? null : v.startedAt;

  const prev = await prisma.office.findUnique({ where: { id } });
  if (!prev) return { ok: false, error: "找不到職務" };

  const diff = buildDiff({
    title: [prev.title, title],
    currentMembers: [prev.currentMembers, v.members],
    isVacant: [prev.isVacant, input.isVacant],
    startedAt: [prev.startedAt?.toISOString() ?? null, startedAt?.toISOString() ?? null],
    note: [prev.note, note],
  });
  if (Object.keys(diff).length === 0) {
    return { ok: true, officeId: id }; // 沒有變更，不留空 log
  }

  await prisma.$transaction(async (tx) => {
    await tx.office.update({
      where: { id },
      data: {
        title,
        currentMembers: v.members as unknown as Prisma.InputJsonValue,
        isVacant: input.isVacant,
        startedAt,
        note,
      },
    });
    await tx.officeEditLog.create({
      data: {
        officeId: id,
        editorEmail: admin.email,
        action: "manual_edit",
        summary: `手動編輯職務「${title}」`,
        diff: diff as Prisma.InputJsonValue,
      },
    });
  }, { timeout: 10_000 });

  revalidatePath("/admin/offices");
  revalidatePath(`/admin/offices/${id}`);
  return { ok: true, officeId: id };
}

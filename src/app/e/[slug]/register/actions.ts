"use server";
// 候選人登記 server action。安全不變量：
// 1. 身分一律取自 session（requireSession），createdBy 由伺服器戳記，不信 client。
// 2. 禁止重複登記：同一登記者（createdBy）已有非 rejected/withdrawn 的登記就拒絕新增；
//    needs_fix 狀態允許編輯重送（同一筆覆寫，狀態轉回 pending）。
// 3. 附件一律驗證屬於本場選舉、且是本人上傳，擋別人 upload id 被拿來冒用。

import { Prisma } from "@/generated/prisma/client";
import { z } from "zod";
import { requireSession } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { registrationDecision, REGISTRATION_REJECTION_MESSAGES } from "@/lib/registration-policy";

const memberSchema = z.object({
  name: z.string().trim().min(1, "姓名必填").max(50),
  email: z.string().trim().min(1, "email 必填").max(120).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "email 格式不正確"),
  grade: z.string().trim().min(1, "年級／班級必填").max(20),
  // 大頭照 Upload id：選罷法要求選票載明相片，必填。實際歸屬（kind=photo、屬於本場選舉、
  // 本人上傳）在下面另外查 DB 驗證，這裡只驗格式非空。
  photo: z.string().trim().min(1, "請上傳大頭照"),
});

const inputSchema = z.object({
  members: z.array(memberSchema).min(1).max(2),
  platform: z.string().trim().min(1, "請填寫政見").max(4000, "政見過長"),
  attachmentIds: z.array(z.string().min(1)).min(1, "請上傳至少一份學生證影本"),
});

export type RegisterInput = z.infer<typeof inputSchema>;
export type RegisterResult = { ok: true; status: "pending" } | { ok: false; error: string };

export async function registerCandidate(
  slug: string,
  input: RegisterInput,
): Promise<RegisterResult> {
  const session = await requireSession(`/e/${slug}/register`);

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "表單格式不正確" };
  }
  const data = parsed.data;

  const election = await prisma.election.findFirst({ where: { slug, hiddenAt: null } });
  if (!election) return { ok: false, error: "找不到這場選舉" };
  const decision = registrationDecision(election, new Date());
  if (!decision.ok) {
    return { ok: false, error: REGISTRATION_REJECTION_MESSAGES[decision.reason] };
  }

  const expectedCount = election.kind === "leader" ? 2 : 1;
  if (data.members.length !== expectedCount) {
    return {
      ok: false,
      error:
        election.kind === "leader"
          ? "學生會長／副會長場次需填候選人與副手兩組資料"
          : "請填寫登記人資料",
    };
  }

  const uploads = await prisma.upload.findMany({
    where: {
      id: { in: data.attachmentIds },
      electionId: election.id,
      uploaderSub: session.sub,
      kind: "attachment",
    },
    select: { id: true },
  });
  if (uploads.length !== data.attachmentIds.length) {
    return { ok: false, error: "附件無效或不屬於你，請重新上傳" };
  }

  // 大頭照同樣要驗證屬於本場選舉、本人上傳，且必須是 kind=photo（擋把附件 id 冒充大頭照，
  // 或反過來把大頭照 id 冒充附件——兩條下載路徑的把關邊界要在寫入這裡就鎖死，不是只靠讀取端）。
  const photoIds = data.members.map((m) => m.photo);
  const photos = await prisma.upload.findMany({
    where: {
      id: { in: photoIds },
      electionId: election.id,
      uploaderSub: session.sub,
      kind: "photo",
    },
    select: { id: true },
  });
  if (photos.length !== new Set(photoIds).size) {
    return { ok: false, error: "大頭照無效或不屬於你，請重新上傳" };
  }

  // electionId+createdBy 有 DB 唯一索引（一人一場一筆）；這裡只用它查有沒有既有登記、
  // 拿 id 定位要不要走覆寫路徑，不再拿查到的 status 在 JS 判斷可否重送——那個「先查狀態、
  // 再無條件 upsert」的兩步窗口，選委剛好把這筆核准 commit 成 approved 時，upsert 仍會用
  // 查到的舊狀態（needs_fix）覆寫回 pending，把核准結果吃掉（D7-5 第 2 輪）。
  // 只有 needs_fix（編輯重送）與 rejected/withdrawn（重新登記）允許覆寫；其餘狀態
  // （pending/approved）視為「已經登記過」擋掉——這條件現在放進 updateMany 的 WHERE，
  // 在真正寫入那一刻對 DB 現值求值，不會再有先查後寫的窗口。
  const existing = await prisma.candidate.findUnique({
    where: { electionId_createdBy: { electionId: election.id, createdBy: session.email } },
    select: { id: true },
  });

  const membersJson = data.members as unknown as Prisma.InputJsonValue;
  const attachmentsJson = data.attachmentIds as unknown as Prisma.InputJsonValue;

  if (existing) {
    const rewrite = await prisma.candidate.updateMany({
      where: { id: existing.id, status: { in: ["needs_fix", "rejected", "withdrawn"] } },
      data: {
        members: membersJson,
        platform: data.platform,
        attachments: attachmentsJson,
        status: "pending",
        reviewNote: null,
      },
    });
    if (rewrite.count === 0) {
      return { ok: false, error: "你已經登記過這場選舉了" };
    }
    return { ok: true, status: "pending" };
  }

  // 還沒登記過：直接 create。撞 electionId+createdBy 的唯一索引（雙擊送出時 race 出
  // 兩筆重複登記）就回同一句「已經登記過」，不讓裸露的 Prisma 例外洩出去。
  try {
    await prisma.candidate.create({
      data: {
        electionId: election.id,
        members: membersJson,
        platform: data.platform,
        attachments: attachmentsJson,
        status: "pending",
        createdBy: session.email,
      },
    });
    return { ok: true, status: "pending" };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "你已經登記過這場選舉了" };
    }
    throw e;
  }
}

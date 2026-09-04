// 選舉建立／編輯表單共用的驗證與小工具。new/actions.ts 與 [id]/edit/actions.ts 共用同一份規則，
// 避免兩處零散各寫一份 zod schema 導致新增與編輯的驗證漂移。
import { z } from "zod";

export const ELECTION_KINDS = ["leader", "grade_rep", "other"] as const;
export type ElectionKind = (typeof ELECTION_KINDS)[number];

export const ELECTION_KIND_LABEL: Record<ElectionKind, string> = {
  leader: "學生會長／副會長",
  grade_rep: "年級代表",
  other: "其他",
};

// 選罷法 §26-1 Ⅱ：數位選舉之投票期間不得少於四十八小時。這裡擋「填了但太短」，
// 「根本沒填」則由 advanceStatus 在開放投票時擋（見 [id]/actions.ts）。
export const MIN_VOTING_HOURS = 48;
const MIN_VOTING_MS = MIN_VOTING_HOURS * 3_600_000;

// FormData.get() 對「表單裡沒有這個欄位」回傳 null，對「有欄位但沒填」回傳空字串。
// 兩者都是「未設定」，但 zod 不這麼想：null 會落進 z.coerce.date() 變成 1970-01-01，
// 落進 z.string() 則直接報型別錯。所以在 preprocess 就把兩者一起收斂成 undefined。
const blankToUndefined = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? undefined : v;

// datetime-local 的 <input> 值是空字串或 "YYYY-MM-DDTHH:mm"；空字串視為未設定。
const optionalDatetimeLocal = z.preprocess(blankToUndefined, z.coerce.date().optional());

export const electionFormSchema = z
  .object({
    title: z.string().trim().min(1, "請輸入選舉名稱").max(100, "選舉名稱過長"),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2, "slug 至少 2 個字元")
      .max(50, "slug 過長")
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug 只能是小寫英數與連字號，且不能開頭/結尾/連續使用連字號"),
    kind: z.enum(ELECTION_KINDS),
    seats: z.coerce.number().int("名額須為整數").min(1, "名額至少 1").max(50, "名額過多"),
    maxChoices: z.coerce
      .number()
      .int("可選人數須為整數")
      .min(1, "可選人數至少 1")
      .max(50, "可選人數過多"),
    registrationStartsAt: optionalDatetimeLocal,
    registrationEndsAt: optionalDatetimeLocal,
    votingStartsAt: optionalDatetimeLocal,
    votingEndsAt: optionalDatetimeLocal,
    // 對應職務：空＝genesis（公告時自動新建職務並回填）；有值＝這場填既有職務（連任/補選換人）。
    officeId: z.preprocess(blankToUndefined, z.string().optional()),
  })
  .refine(
    (v) => !v.registrationStartsAt || !v.registrationEndsAt || v.registrationEndsAt > v.registrationStartsAt,
    { message: "登記截止時間須晚於開始時間", path: ["registrationEndsAt"] },
  )
  .refine((v) => !v.votingStartsAt || !v.votingEndsAt || v.votingEndsAt > v.votingStartsAt, {
    message: "投票截止時間須晚於開始時間",
    path: ["votingEndsAt"],
  })
  .refine(
    (v) =>
      !v.votingStartsAt ||
      !v.votingEndsAt ||
      v.votingEndsAt.getTime() - v.votingStartsAt.getTime() >= MIN_VOTING_MS,
    {
      message: `投票期間不得少於 ${MIN_VOTING_HOURS} 小時（選罷法 §26-1 Ⅱ）`,
      path: ["votingEndsAt"],
    },
  )
  // §13：學生代表為複數選區單記不可讓渡投票制——每人只有一票，不得連記。
  .refine((v) => v.kind !== "grade_rep" || v.maxChoices === 1, {
    message: "學生代表選舉採單記不可讓渡，可選人數只能是 1（選罷法 §13）",
    path: ["maxChoices"],
  });

export type ElectionFormValues = z.infer<typeof electionFormSchema>;

export interface ElectionFormResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<keyof ElectionFormValues, string>>;
  electionId?: string;
  slug?: string;
}

export function parseElectionForm(
  formData: FormData,
): { ok: true; data: ElectionFormValues } | { ok: false; result: ElectionFormResult } {
  const raw = {
    title: formData.get("title"),
    slug: formData.get("slug"),
    kind: formData.get("kind"),
    seats: formData.get("seats"),
    maxChoices: formData.get("maxChoices"),
    registrationStartsAt: formData.get("registrationStartsAt"),
    registrationEndsAt: formData.get("registrationEndsAt"),
    votingStartsAt: formData.get("votingStartsAt"),
    votingEndsAt: formData.get("votingEndsAt"),
    officeId: formData.get("officeId"),
  };
  const parsed = electionFormSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<keyof ElectionFormValues, string>> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof ElectionFormValues | undefined;
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return {
      ok: false,
      result: { ok: false, error: "表單有欄位不正確，請檢查後再送出", fieldErrors },
    };
  }
  return { ok: true, data: parsed.data };
}

// <input type="datetime-local"> 需要的字串格式（本地時間，無時區）。
export function toDatetimeLocalValue(d: Date | null | undefined): string {
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

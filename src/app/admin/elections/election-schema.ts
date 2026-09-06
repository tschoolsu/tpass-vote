// 選舉建立／編輯表單共用的驗證與小工具。new/actions.ts 與 [id]/edit/actions.ts 共用同一份規則，
// 避免兩處零散各寫一份 zod schema 導致新增與編輯的驗證漂移。
import { z } from "zod";
import { SITE_TIMEZONE } from "@/config/site";

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

// datetime-local 的 <input> 值是空字串或 "YYYY-MM-DDTHH:mm"（無時區資訊的「牆上時間」）。
// 選委腦中想的一律是台北時間，不是 server 跑在哪個時區——不能用 z.coerce.date()／
// new Date(str) 直接吃，那是用 server 的 process TZ 解讀。這裡固定以 SITE_TIMEZONE 解讀。

/** 把某個瞬間在 timeZone 的牆上時間拆成欄位。withSeconds 只有 tzOffsetMinutes 算偏移時需要。 */
function partsInTimeZone(
  instant: Date,
  timeZone: string,
  withSeconds: boolean,
): Record<string, string> {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" as const } : {}),
  })
    .formatToParts(instant)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
}

/** 給定一個瞬間，回傳 timeZone 在該瞬間的 UTC 偏移（分鐘，東半球為正）。 */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = partsInTimeZone(instant, timeZone, true);
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asIfUtc - instant.getTime()) / 60_000;
}

/** 把 datetime-local 的「YYYY-MM-DDTHH:mm」牆上時間，以 timeZone 的觀點解讀成正確的 UTC 瞬間。 */
export function parseDatetimeLocalInTimeZone(value: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return new Date(NaN);
  const [, y, mo, d, hh, mi] = m;
  const naiveUtcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi));
  // Asia/Taipei 全年無 DST，偏移是常數，用哪個瞬間量測都一樣；一次修正即可得到精確瞬間。
  const offsetMin = tzOffsetMinutes(new Date(naiveUtcMs), timeZone);
  const instant = new Date(naiveUtcMs - offsetMin * 60_000);
  // regex 只驗格式，不驗值域——month=13／day=45 這種越界輸入會被 Date.UTC 靜默進位成別的
  // 日期。用「解析完再格式化回去比對」抓出這種格式對但值域錯的輸入，而不是信任進位結果。
  if (formatInTimeZone(instant, timeZone) !== value) return new Date(NaN);
  return instant;
}

function formatInTimeZone(instant: Date, timeZone: string): string {
  const parts = partsInTimeZone(instant, timeZone, false);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const optionalDatetimeLocal = z.preprocess((v) => {
  const val = blankToUndefined(v);
  if (val === undefined || typeof val !== "string") return val;
  return parseDatetimeLocalInTimeZone(val, SITE_TIMEZONE);
}, z.date().optional());

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
  // 送出失敗時，把使用者原始輸入帶回去，讓表單用它回填而不是清空
  // （React 19 的 <form action> 在 action 結束後會用當下的 defaultValue reset 表單）。
  values?: Record<string, string>;
}

const FORM_FIELD_KEYS = [
  "title",
  "slug",
  "kind",
  "seats",
  "maxChoices",
  "registrationStartsAt",
  "registrationEndsAt",
  "votingStartsAt",
  "votingEndsAt",
  "officeId",
] as const;

// 從 FormData 撈出使用者原始輸入（字串形式，未經 zod 轉換），供送出失敗時回填表單。
export function extractFormValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of FORM_FIELD_KEYS) {
    const v = formData.get(key);
    if (typeof v === "string") values[key] = v;
  }
  return values;
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
      result: {
        ok: false,
        error: "表單有欄位不正確，請檢查後再送出",
        fieldErrors,
        values: extractFormValues(formData),
      },
    };
  }
  return { ok: true, data: parsed.data };
}

// <input type="datetime-local"> 需要的字串格式（無時區）。用 SITE_TIMEZONE 回填，不是
// server 的 process TZ／getHours() 那種本地時間，否則跟 parseDatetimeLocalInTimeZone 對不上。
export function toDatetimeLocalValue(d: Date | null | undefined): string {
  if (!d) return "";
  return formatInTimeZone(d, SITE_TIMEZONE);
}

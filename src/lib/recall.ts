// 罷免規則（純函式，無 IO）。供連署/開票 server action 共用，也供單元測試。
//
// 法源對應：
// - §28：會長副會長罷免案提出，應有當屆有效票總數 2/5 以上之連署。
// - §36：罷免案投票，同意罷免票數多於不同意罷免票數者，通過。
import { SITE_TIMEZONE } from "@/config/site";

// 連署門檻：原選舉有效票總數（validCount）的 2/5，無條件進位。
export function recallThreshold(parentValidCount: number): number {
  return Math.ceil((parentValidCount * 2) / 5);
}

// 罷免案通過判定：同意 > 不同意（相等或更少則否決）。
export function recallPassed(agree: number, disagree: number): boolean {
  return agree > disagree;
}

// §27：當選人就職未滿 2 個月者，不得提起罷免。以下為硬性判定（就職日未知＝不得提起）。
export const RECALL_ELIGIBLE_MONTHS = 2;

// 把某個瞬間在 timeZone 的牆上時間拆成年月日時分秒（數字）。
function partsInTimeZone(instant: Date, timeZone: string): [number, number, number, number, number, number] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(instant)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  return [
    Number(parts.year),
    Number(parts.month),
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  ];
}

// 給定一個瞬間，回傳 timeZone 在該瞬間的 UTC 偏移（分鐘，東半球為正）。
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const [y, mo, d, h, mi, s] = partsInTimeZone(instant, timeZone);
  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return (asIfUtc - instant.getTime()) / 60_000;
}

// 可提起罷免的最早日期＝就職日 + 2 個月，以 SITE_TIMEZONE 的牆上時間加月，不依賴
// server 的 process TZ。startedAt 來自 offices/actions.ts 的 parseStartedAt，是台北牆上
// 那一天午夜換算出的 UTC 瞬間——若這裡改用 setMonth() 在 process TZ 的牆上時間加月，
// 正式主機 TZ=UTC 時會從「台北午夜在 UTC 牆上是前一天 16:00」起算，月長進位一撞就偏掉
// （方向不定，可能提早也可能延後放行罷免）。
export function recallEligibleFrom(startedAt: Date): Date {
  const [y, mo, d, h, mi, s] = partsInTimeZone(startedAt, SITE_TIMEZONE);
  // 目標月份的牆上時間，先當成 UTC 瞬間放著（跟 parseDatetimeLocalInTimeZone 同一手法）；
  // mo 超過 12 時 Date.UTC 會自然進位到下一年，等同原本 setMonth() 的月份進位規則。
  const naiveUtcMs = Date.UTC(y, mo - 1 + RECALL_ELIGIBLE_MONTHS, d, h, mi, s);
  const offsetMin = tzOffsetMinutes(new Date(naiveUtcMs), SITE_TIMEZONE);
  return new Date(naiveUtcMs - offsetMin * 60_000);
}

// 現在是否已可對「就職日為 startedAt」的職務提起罷免。startedAt 為 null（就職日未知）＝不得提起。
export function canInitiateRecall(startedAt: Date | null, now: Date): boolean {
  if (!startedAt) return false;
  return now.getTime() >= recallEligibleFrom(startedAt).getTime();
}

// 罷免事由長度上限。這是全站唯一「任一登入師生能寫進 DB、內容完全由他決定」的自由文字
// 欄位——Election.recallReason 是 Postgres TEXT，DB 不設限；next.config.ts 為了大場次開票
// 把 serverActions.bodySizeLimit 放寬到 8mb，所以沒有這條檢查時，單發就能塞 8MB 垃圾，
// 每個職務各塞一發、永久躺著。其餘公開寫入路徑各自有擋（投票 row lock、連署與登記的唯一
// 索引、上傳的每人每場 20 檔配額），只有這裡漏掉。
//
// 數字沿用 InitiateRecallForm 原本就有的 maxLength={4000}：前端一直是這個上限，只是它
// 可以被繞過（server action 直接呼叫即可），這裡是把同一條規則補到擋得住的那一層，
// 不順手收緊既有行為。
//
// 以碼點計而非 String.length：後者一個 emoji 算 2，同樣的可見字數會依內容給出不同結果。
export const RECALL_REASON_MAX_LENGTH = 4000;

export type RecallReasonResult = { ok: true; value: string } | { ok: false; error: string };

// 事由的正規化＋驗證。單一事實來源：server action 與登記表單的 maxLength 都讀這裡，
// 前端只是 UX，真正的把關在 action 內。
export function validateRecallReason(raw: string): RecallReasonResult {
  const value = raw.trim();
  if (value === "") return { ok: false, error: "請填寫罷免事由" };
  if (Array.from(value).length > RECALL_REASON_MAX_LENGTH) {
    return { ok: false, error: `罷免事由過長（上限 ${RECALL_REASON_MAX_LENGTH} 字）` };
  }
  return { ok: true, value };
}

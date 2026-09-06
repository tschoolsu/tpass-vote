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

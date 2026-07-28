// 罷免規則（純函式，無 IO）。供連署/開票 server action 共用，也供單元測試。
//
// 法源對應：
// - §28：會長副會長罷免案提出，應有當屆有效票總數 2/5 以上之連署。
// - §36：罷免案投票，同意罷免票數多於不同意罷免票數者，通過。

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

// 可提起罷免的最早日期＝就職日 + 2 個月。
export function recallEligibleFrom(startedAt: Date): Date {
  const d = new Date(startedAt);
  d.setMonth(d.getMonth() + RECALL_ELIGIBLE_MONTHS);
  return d;
}

// 現在是否已可對「就職日為 startedAt」的職務提起罷免。startedAt 為 null（就職日未知）＝不得提起。
export function canInitiateRecall(startedAt: Date | null, now: Date): boolean {
  if (!startedAt) return false;
  return now.getTime() >= recallEligibleFrom(startedAt).getTime();
}

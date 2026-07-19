// 選舉狀態機邏輯層的單一真相：合法狀態集合、單向前進表、鎖定判斷。
// 顯示用 meta（label/badgeClass）不放這裡，見 src/components/admin/status.ts；
// 這裡的常數才是「轉移/鎖定合法性」的依據，各 action / page 一律從這裡 import，不得自行定義。
//
// 兩條鏈共用 voting 之後的區段（closed/sealed/published，走既有 sealElection/公告發布）：
// - 一般鏈：draft → registration → campaigning → voting → closed → sealed → published
// - 罷免鏈（kind="recall"）：petition → established → voting → closed → sealed → published
//   petition/established 為罷免專屬前置（連署門檻達成前後），一般選舉不會進入這兩個狀態。
export const ELECTION_STATUSES = [
  "petition",
  "established",
  "draft",
  "registration",
  "campaigning",
  "voting",
  "closed",
  "sealed",
  "published",
] as const;
export type ElectionStatus = (typeof ELECTION_STATUSES)[number];

// 單向前進表（一般鏈）：只涵蓋一般 advanceStatus 能推的區段。closed→sealed 走既有 sealElection，
// sealed→published 走公告頁發布 result 公告時一併處理，兩者都不在這張表裡。
export const NEXT_STATUS: Partial<Record<ElectionStatus, ElectionStatus>> = {
  draft: "registration",
  registration: "campaigning",
  campaigning: "voting",
  voting: "closed",
};

// 單向前進表（罷免鏈）：petition/established 為罷免專屬前置；voting 之後與一般鏈共用同一段。
const RECALL_NEXT_STATUS: Partial<Record<ElectionStatus, ElectionStatus>> = {
  petition: "established",
  established: "voting",
  voting: "closed",
};

// kind 選填、預設走一般鏈（向後相容既有呼叫端）；kind="recall" 時走罷免鏈。
export function nextStatus(status: ElectionStatus, kind?: string): ElectionStatus | undefined {
  return kind === "recall" ? RECALL_NEXT_STATUS[status] : NEXT_STATUS[status];
}

// 投票開始後（voting 及之後的每個狀態）名冊/候選人/選舉基本資料一律鎖定；
// petition/established 為罷免名冊建立即鎖、全程不可改，故一併鎖定。
// 型別故意寬鬆成 Set<string>：election.status 從 Prisma 讀出來是 string，呼叫端不必逐一轉型。
export const LOCKED_STATUSES: Set<string> = new Set([
  "petition",
  "established",
  "voting",
  "closed",
  "sealed",
  "published",
]);

export function isLocked(status: string): boolean {
  return LOCKED_STATUSES.has(status);
}

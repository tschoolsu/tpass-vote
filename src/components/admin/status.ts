// 選舉狀態機的顯示中繼資料（純資料，無 IO）。狀態機本身（合法轉移）由各 actions.ts 集中把關，
// 這裡只負責「畫面上這個狀態長什麼樣子」，不得反過來被拿去當作轉移合法性的依據。
export const ELECTION_STATUSES = [
  "draft",
  "registration",
  "campaigning",
  "voting",
  "closed",
  "sealed",
  "published",
] as const;
export type ElectionStatus = (typeof ELECTION_STATUSES)[number];

export const STATUS_META: Record<ElectionStatus, { label: string; badgeClass: string }> = {
  draft: { label: "草稿", badgeClass: "bg-card" },
  registration: { label: "候選人登記中", badgeClass: "bg-tone-blue-badge text-tone-blue-text" },
  campaigning: { label: "政見發表中", badgeClass: "bg-tone-violet-badge text-tone-violet-text" },
  voting: { label: "投票中", badgeClass: "bg-tone-green-badge text-tone-green-text" },
  closed: { label: "已截止（待彌封）", badgeClass: "bg-tone-orange-badge text-tone-orange-text" },
  sealed: { label: "已彌封（待開票）", badgeClass: "bg-tone-rose-badge text-tone-rose-text" },
  published: { label: "已公告結果", badgeClass: "bg-tone-blue-badge text-tone-blue-text" },
};

// 單向前進表：只涵蓋一般 advanceStatus 能推的區段。closed→sealed 走既有 sealElection，
// sealed→published 走公告頁發布 result 公告時一併處理，兩者都不在這張表裡。
export const NEXT_STATUS: Partial<Record<ElectionStatus, ElectionStatus>> = {
  draft: "registration",
  registration: "campaigning",
  campaigning: "voting",
  voting: "closed",
};

export const CANDIDATE_STATUS_META: Record<string, { label: string; badgeClass: string }> = {
  pending: { label: "待審核", badgeClass: "bg-tone-blue-badge text-tone-blue-text" },
  needs_fix: { label: "退回補正", badgeClass: "bg-tone-orange-badge text-tone-orange-text" },
  approved: { label: "已核准", badgeClass: "bg-tone-green-badge text-tone-green-text" },
  rejected: { label: "已拒絕", badgeClass: "bg-tone-rose-badge text-tone-rose-text" },
  withdrawn: { label: "已撤回", badgeClass: "bg-card" },
};

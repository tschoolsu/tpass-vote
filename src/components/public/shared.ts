// 公開端共用的純函式與標籤對照表。無 hooks、無 IO，server / client component 都能安全 import。
// Tailwind class 一律寫死字面量（不用樣板字串組 class），否則 JIT 掃不到會漏樣式。

export const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  registration: "候選人登記中",
  campaigning: "公告期",
  voting: "投票中",
  closed: "投票已截止",
  sealed: "開票中",
  published: "結果已公布",
};

export const STATUS_STYLE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  registration: "bg-tone-blue-badge text-tone-blue-text",
  campaigning: "bg-tone-violet-badge text-tone-violet-text",
  voting: "bg-tone-green-badge text-tone-green-text",
  closed: "bg-tone-orange-badge text-tone-orange-text",
  sealed: "bg-tone-orange-badge text-tone-orange-text",
  published: "bg-tone-green-badge text-tone-green-text",
};

export const KIND_LABEL: Record<string, string> = {
  leader: "學生會長／副會長",
  grade_rep: "班聯會代表",
  other: "其他選舉",
};

export const CANDIDATE_STATUS_LABEL: Record<string, string> = {
  pending: "審核中",
  needs_fix: "待補件",
  approved: "已核准",
  rejected: "未通過",
  withdrawn: "已撤回",
};

export const CANDIDATE_STATUS_STYLE: Record<string, string> = {
  pending: "bg-tone-blue-badge text-tone-blue-text",
  needs_fix: "bg-tone-orange-badge text-tone-orange-text",
  approved: "bg-tone-green-badge text-tone-green-text",
  rejected: "bg-destructive text-primary-foreground",
  withdrawn: "bg-muted text-muted-foreground",
};

export const ANNOUNCEMENT_KIND_LABEL: Record<string, string> = {
  first: "第一次公告（投票前 30 日）",
  second: "第二次公告（投票前 14 日）",
  result: "開票結果公告（開票後 7 日內）",
};

export const ANNOUNCEMENT_KINDS = ["first", "second", "result"] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

export function isAnnouncementKind(v: string): v is AnnouncementKind {
  return (ANNOUNCEMENT_KINDS as readonly string[]).includes(v);
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "未定";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 距離目標時間的白話描述（靜態算一次，非即時倒數）。 */
export function describeRemaining(
  target: Date | string | null | undefined,
  now: Date,
): string | null {
  if (!target) return null;
  const date = typeof target === "string" ? new Date(target) : target;
  const diffMs = date.getTime() - now.getTime();
  const future = diffMs >= 0;
  const abs = Math.abs(diffMs);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);

  let span: string;
  if (days > 0) span = `${days} 天 ${hours} 小時`;
  else if (hours > 0) span = `${hours} 小時 ${minutes} 分`;
  else span = `${minutes} 分鐘`;

  return future ? `還剩 ${span}` : `已過 ${span}`;
}

export interface MemberInfo {
  name: string;
  email: string;
  grade: string;
}

/** 候選人顯示名稱：leader 場次聯名顯示（候選人＋副手），其餘單人。 */
export function candidateDisplayName(kind: string, members: MemberInfo[]): string {
  if (kind === "leader" && members.length >= 2) {
    return `${members[0]?.name ?? "?"} ・ ${members[1]?.name ?? "?"}（副手）`;
  }
  return members.map((m) => m.name).join("、") || "（未填姓名）";
}

/** 供 <meta description> 用的純文字摘要：去掉常見 markdown 符號、截斷。 */
export function plainExcerpt(text: string, max = 140): string {
  const plain = text
    .replace(/[#*_`>]/g, "")
    .replace(/^-+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

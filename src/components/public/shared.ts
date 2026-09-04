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
  petition: "連署中",
  established: "已成立",
};

export const STATUS_STYLE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  registration: "bg-tone-blue-badge text-tone-blue-text",
  campaigning: "bg-tone-violet-badge text-tone-violet-text",
  voting: "bg-tone-green-badge text-tone-green-text",
  closed: "bg-tone-orange-badge text-tone-orange-text",
  sealed: "bg-tone-orange-badge text-tone-orange-text",
  published: "bg-tone-green-badge text-tone-green-text",
  petition: "bg-tone-orange-badge text-tone-orange-text",
  established: "bg-tone-violet-badge text-tone-violet-text",
};

export const KIND_LABEL: Record<string, string> = {
  leader: "學生會長／副會長",
  grade_rep: "班聯會代表",
  other: "其他選舉",
  recall: "罷免案",
};

// 一般選舉複製出的三種衍生場次（罷免案的 parentId 另外處理，不用這張表——見 e/[slug]/page.tsx）。
export const LINEAGE_LABEL: Record<string, string> = {
  runoff: "重選場次",
  by_election: "補選場次",
  redo: "重辦場次",
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

export const LEGAL_TAG_LABEL: Record<string, string> = {
  first: "第一次公告（投票前 30 日）",
  second: "第二次公告（投票前 14 日）",
  result: "開票結果公告（開票後 7 日內）",
};

export const LEGAL_TAGS = ["first", "second", "result"] as const;
export type LegalTag = (typeof LEGAL_TAGS)[number];

export function isLegalTag(v: string): v is LegalTag {
  return (LEGAL_TAGS as readonly string[]).includes(v);
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
  // 大頭照的 Upload id（走 /api/photos/[id] 公開顯示）。選罷法要求選票載明相片，新登記一律必填；
  // 型別留 optional 只是為了相容登記於此欄位存在前的既有資料，讀取端要能處理沒有相片的情況。
  photo?: string | null;
}

/** 候選人顯示名稱：leader 場次聯名顯示（候選人＋副手），其餘單人。 */
export function candidateDisplayName(kind: string, members: MemberInfo[]): string {
  if (kind === "leader" && members.length >= 2) {
    return `${members[0]?.name ?? "?"} ・ ${members[1]?.name ?? "?"}（副手）`;
  }
  return members.map((m) => m.name).join("、") || "（未填姓名）";
}

/**
 * 投票頁頂部情境說明：候選組數 > 名額（超額競選）採圈選投票——單一席次為相對多數決（§12），
 * 複數席次且每人一票為單記不可讓渡（§13）；候選組數 ≤ 名額（同額／不足額競選）依 §26 Ⅲ
 * 改採同意／不同意投票。純文案，不參與任何送出/加密/計票判斷——ballotMode 本身仍由伺服器端
 * election-status 相關邏輯決定。
 */
export function ballotModeExplainer(params: {
  ballotMode: "choose" | "approval";
  candidateCount: number;
  seats: number;
  maxChoices: number;
}): { label: string; body: string } {
  const { ballotMode, candidateCount, seats, maxChoices } = params;
  if (ballotMode === "choose") {
    if (seats > 1 && maxChoices === 1) {
      return {
        label: "複數選區單記不可讓渡・圈選投票",
        body: `本場選舉有 ${candidateCount} 組候選人競選 ${seats} 席。你只有一票，請圈選一組，得票最高的 ${seats} 組當選，或選擇投廢票。`,
      };
    }
    return {
      label: "超額競選・圈選投票",
      body: `本場選舉有 ${candidateCount} 組候選人競選 ${seats} 席。你有 ${maxChoices} 票，可從候選人中圈選最多 ${maxChoices} 組，或選擇投廢票。`,
    };
  }
  return {
    label: "同額／不足額競選・同意投票",
    body: `本場候選組數（${candidateCount}）未超過名額（${seats}），依選罷法 §26 Ⅲ 改採同意／不同意投票：請就每一組候選人表達同意或不同意，有效同意票數多於不同意票數者當選，或選擇投廢票。`,
  };
}

/**
 * 把一筆去識別化選票明細（§26-1 Ⅳ）翻成人看得懂的一行。
 * labels 是「候選人 id → 顯示名稱」的對照表，由頁面端從核准候選人組出來。
 */
export function describeDisclosure(
  entry: { kind: string; candidateIds?: string[]; approvals?: Record<string, boolean> },
  labels: Record<string, string>,
): string {
  const label = (id: string) => labels[id] ?? id;
  switch (entry.kind) {
    case "choose":
      return (entry.candidateIds ?? []).map(label).join("、") || "（無）";
    case "approval":
      return (
        Object.entries(entry.approvals ?? {})
          .map(([id, agree]) => `${label(id)}：${agree ? "同意" : "不同意"}`)
          .join("・") || "（無）"
      );
    case "blank":
      return "廢票（不圈選）";
    default:
      return "無效票";
  }
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

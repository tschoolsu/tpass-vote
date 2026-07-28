// 選舉狀態機的顯示中繼資料（純資料，無 IO）。狀態機本身（合法轉移/鎖定）的單一真相在
// src/lib/election-status.ts；這裡只負責「畫面上這個狀態長什麼樣子」，不得反過來被拿去
// 當作轉移合法性的依據。型別/常數從 lib re-export，避免大量改 import。
export {
  ELECTION_STATUSES,
  NEXT_STATUS,
  LOCKED_STATUSES,
  nextStatus,
  isLocked,
  type ElectionStatus,
} from "@/lib/election-status";
import type { ElectionStatus } from "@/lib/election-status";

export const STATUS_META: Record<ElectionStatus, { label: string; badgeClass: string }> = {
  petition: { label: "連署中", badgeClass: "bg-tone-orange-badge text-tone-orange-text" },
  established: { label: "已成案", badgeClass: "bg-tone-violet-badge text-tone-violet-text" },
  draft: { label: "草稿", badgeClass: "bg-card" },
  registration: { label: "候選人登記中", badgeClass: "bg-tone-blue-badge text-tone-blue-text" },
  campaigning: { label: "政見發表中", badgeClass: "bg-tone-violet-badge text-tone-violet-text" },
  voting: { label: "投票中", badgeClass: "bg-tone-green-badge text-tone-green-text" },
  closed: { label: "已截止（待彌封）", badgeClass: "bg-tone-orange-badge text-tone-orange-text" },
  sealed: { label: "已彌封（待開票）", badgeClass: "bg-tone-rose-badge text-tone-rose-text" },
  published: { label: "已公告結果", badgeClass: "bg-tone-blue-badge text-tone-blue-text" },
};

// 工作台「截止＋開票」UX 合併：closed／sealed 在畫面上合併成同一階段區塊（純呈現層），
// 底層狀態機（lib/election-status）完全不變、仍是 closed/sealed 兩個獨立值。
// 額外規則：提交計票結果後（election.resultsJson != null）即使 status 仍是 sealed，
// 工作台的「目前步驟」也要提前推進到 published，讓結果公告草稿立即可見可編——
// 呼叫端請用 toUiStage(status, kind) 算出原始階段，再視 resultsExist 決定是否再推一格。
//
// UiStage 是一般鏈（6 步）與罷免鏈（5 步）全部步驟字面值的聯集：兩條鏈各自只用其中一部分
// （見 UI_STAGES / RECALL_UI_STAGES），共用同一個型別方便 StageProgress/WorkbenchAccordion
// 兩條鏈共用同一組元件，呼叫端決定要傳哪一份 stages/labels。
export type UiStage =
  | "draft"
  | "registration"
  | "campaigning"
  | "petition"
  | "established"
  | "voting"
  | "closing"
  | "published";

// 一般鏈六步顯示順序。
export const UI_STAGES: readonly UiStage[] = [
  "draft",
  "registration",
  "campaigning",
  "voting",
  "closing",
  "published",
];

export const UI_STAGE_LABEL: Record<UiStage, string> = {
  draft: "①設定",
  registration: "②登記",
  campaigning: "③政見",
  voting: "④投票",
  closing: "⑤截止與開票",
  published: "⑥結果公告",
  petition: "", // 一般鏈不使用，補齊 Record 型別
  established: "",
};

// 罷免鏈五步顯示順序：petition（連署）→ established（成立與答辯）→ voting → closing → published。
// 沒有一般鏈的「①設定」「②登記」「③政見」——罷免場次的開票金鑰在連署階段面板內產生，
// 罷免對象（候選人）建立當下已自動核准，不需要獨立的登記/政見步驟。
export const RECALL_UI_STAGES: readonly UiStage[] = ["petition", "established", "voting", "closing", "published"];

export const RECALL_UI_STAGE_LABEL: Record<UiStage, string> = {
  petition: "①連署",
  established: "②成立與答辯",
  voting: "③投票",
  closing: "④截止與開票",
  published: "⑤結果公告",
  draft: "", // 罷免鏈不使用，補齊 Record 型別
  registration: "",
  campaigning: "",
};

// kind 選填、預設走一般鏈（向後相容既有呼叫端）；kind="recall" 時走罷免鏈五步對照。
export function toUiStage(status: ElectionStatus, kind?: string): UiStage {
  if (status === "closed" || status === "sealed") return "closing";
  if (kind === "recall") return status;
  // 一般鏈狀態機不會走到 petition/established（見 lib/election-status），這裡防呆併入 draft。
  if (status === "petition" || status === "established") return "draft";
  return status;
}

// 罷免案（kind="recall"）沒有 lineage；lineage 只用於一般選舉複製出的三種衍生場次。
export const LINEAGE_LABEL: Record<string, { label: string; badgeClass: string }> = {
  runoff: { label: "重選", badgeClass: "bg-tone-orange-badge text-tone-orange-text" },
  by_election: { label: "補選", badgeClass: "bg-tone-blue-badge text-tone-blue-text" },
  redo: { label: "重辦", badgeClass: "bg-tone-rose-badge text-tone-rose-text" },
};

// kind="recall" 的 kind 徽章（election-schema.ts 的 ELECTION_KIND_LABEL 只涵蓋使用者可選的三種，
// 不含 recall——recall 場次一律由公開發起 initiateRecall 建立，不走選舉建立表單）。
export const RECALL_KIND_META = { label: "罷免案", badgeClass: "bg-tone-violet-badge text-tone-violet-text" };

export const CANDIDATE_STATUS_META: Record<string, { label: string; badgeClass: string }> = {
  pending: { label: "待審核", badgeClass: "bg-tone-blue-badge text-tone-blue-text" },
  needs_fix: { label: "退回補正", badgeClass: "bg-tone-orange-badge text-tone-orange-text" },
  approved: { label: "已核准", badgeClass: "bg-tone-green-badge text-tone-green-text" },
  rejected: { label: "已拒絕", badgeClass: "bg-tone-rose-badge text-tone-rose-text" },
  withdrawn: { label: "已撤回", badgeClass: "bg-card" },
};

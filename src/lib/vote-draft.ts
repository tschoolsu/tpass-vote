// 投票草稿的序列化／還原。純函式，不碰 sessionStorage 本身——
// VoteForm 負責讀寫，這裡只負責「選擇內容 ⇄ 字串」轉換與壞資料防呆。
//
// 密文與收據不進這裡：草稿只記「使用者勾了什麼」，不記加密後的東西。

export interface VoteDraft {
  blank: boolean;
  selected: string[]; // ballotMode="choose" 用
  approvals: Record<string, boolean>; // ballotMode="approval"／罷免用
}

/**
 * 每場選舉、每個投票人各自一個 key。
 *
 * voterId 是必要的隔離維度，不是裝飾：token 過期時整頁會硬導去登入頁再導回來，
 * sessionStorage 是同分頁跨導航存活的——共用電腦（校內電腦教室）常見的「A 選到一半
 * token 過期停在登入頁、A 離開、B 用自己帳號登入接力」，若 key 只綁 slug，B 回到投票頁
 * 會撿到 A 的明文選擇並被當成「已還原你剛才的選擇」顯示出來，等於選票秘密外洩。
 * 綁 voterId 後，不同投票人的 key 天生不同，B 的 mount effect 讀不到 A 的草稿。
 */
export function draftStorageKey(slug: string, voterId: string): string {
  return `tvote:draft:${slug}:${voterId}`;
}

export function serializeDraft(draft: VoteDraft): string {
  return JSON.stringify(draft);
}

/** 壞資料（非本模組寫入的、格式跑掉的、JSON 壞掉的）一律回 null，呼叫端當作沒有草稿處理。 */
export function parseDraft(raw: string | null | undefined): VoteDraft | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidDraftShape(value)) return null;
  return value;
}

function isValidDraftShape(value: unknown): value is VoteDraft {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.blank !== "boolean") return false;
  if (!Array.isArray(v.selected) || !v.selected.every((id) => typeof id === "string")) {
    return false;
  }
  if (typeof v.approvals !== "object" || v.approvals === null || Array.isArray(v.approvals)) {
    return false;
  }
  return Object.values(v.approvals).every((agree) => typeof agree === "boolean");
}

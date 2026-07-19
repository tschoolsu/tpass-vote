// 開票後自動生成「結果公告」草稿的純函式（無 IO）。輸出限定 Markdown.tsx 支援的子集
// （#/##/-/**/[文字](url)），文案要通順、選委能直接小編後發布，不需要重寫。
// 只讀 TallyResult 與候選人基本資料，不碰任何密文/私鑰。
import type { TallyResult } from "@/lib/tally";
import { recallPassed } from "@/lib/recall";

export interface ResultCandidateInfo {
  id: string;
  number: number | null;
  members: { name: string; email?: string; grade?: string }[];
}

export interface ResultElectionInfo {
  title: string;
  kind: string; // leader | grade_rep | other
  seats: number;
}

/** 候選人顯示名稱：leader 場次聯名顯示（候選人＋副手），其餘單人／多人以「、」相接。 */
function candidateLabel(kind: string, members: ResultCandidateInfo["members"]): string {
  if (kind === "leader" && members.length >= 2) {
    return `${members[0]?.name ?? "?"}・${members[1]?.name ?? "?"}（副手）`;
  }
  return members.map((m) => m.name).join("、") || "（未填姓名）";
}

export function resultAnnouncementDraft(
  election: ResultElectionInfo,
  results: TallyResult,
  candidates: ResultCandidateInfo[],
): { title: string; body: string } {
  if (election.kind === "recall") {
    return recallAnnouncementDraft(election, results, candidates);
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const sorted = [...results.candidates].sort((a, b) => {
    if (a.elected !== b.elected) return a.elected ? -1 : 1;
    return b.votes - a.votes;
  });

  const title = `${election.title}開票結果公告`;

  const lines: string[] = [];
  lines.push(`# ${election.title}開票結果`);
  lines.push("");
  lines.push(
    `本次選舉共 ${results.totalBallots} 人投票，選舉人總數 ${results.rosterCount} 人，投票率 ${results.turnoutPct}%。` +
      `有效票 ${results.validCount} 張、廢票 ${results.blankCount} 張、無效票 ${results.invalidCount} 張。`,
  );
  lines.push("");
  lines.push("## 各候選人得票");
  lines.push("");
  for (const c of sorted) {
    const cand = byId.get(c.candidateId);
    const label = cand ? candidateLabel(election.kind, cand.members) : c.candidateId;
    const numberPart = cand?.number ? `${cand.number} 號 ` : "";
    const resultTag = c.tied
      ? results.mode === "choose"
        ? "**（同票，待選委會決議）**"
        : "（同票）"
      : c.elected
        ? "**（當選）**"
        : results.mode === "approval"
          ? "（未通過）"
          : "（未當選）";
    if (results.mode === "approval") {
      lines.push(`- ${numberPart}${label}：同意 ${c.votes} 票、不同意 ${c.disagree} 票 ${resultTag}`);
    } else {
      lines.push(`- ${numberPart}${label}：${c.votes} 票 ${resultTag}`);
    }
  }

  if (results.hasTie) {
    lines.push("");
    lines.push("## 同票說明");
    lines.push("");
    lines.push(
      "本次開票在名額邊界出現同票，依規定不由系統自動裁決，選委會將另行決議（重選或抽籤），後續公告以選委會決議為準。",
    );
  }

  lines.push("");
  lines.push(`本次選舉名額共 ${election.seats} 席，以上為完整計票結果。`);

  return { title, body: lines.join("\n") };
}

/**
 * 罷免案（kind="recall"）開票結果公告：用語與一般選舉不同（同意罷免／不同意罷免、通過／否決），
 * 且結論帶法律效果（§37/§38），不是單純「當選/未當選」。
 */
function recallAnnouncementDraft(
  election: ResultElectionInfo,
  results: TallyResult,
  candidates: ResultCandidateInfo[],
): { title: string; body: string } {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const target = results.candidates[0];
  const cand = target ? byId.get(target.candidateId) : undefined;
  const label = cand ? candidateLabel(election.kind, cand.members) : (target?.candidateId ?? "");
  const passed = target ? recallPassed(target.votes, target.disagree) : false;

  const title = `${election.title}開票結果公告`;

  const lines: string[] = [];
  lines.push(`# ${election.title}開票結果`);
  lines.push("");
  lines.push(
    `本次罷免投票共 ${results.totalBallots} 人投票，選舉人總數 ${results.rosterCount} 人，投票率 ${results.turnoutPct}%。` +
      `有效票 ${results.validCount} 張、廢票 ${results.blankCount} 張、無效票 ${results.invalidCount} 張。`,
  );
  lines.push("");
  lines.push("## 罷免結果");
  lines.push("");
  if (target) {
    lines.push(
      `- ${label}：同意罷免 ${target.votes} 票、不同意罷免 ${target.disagree} 票 **（${passed ? "通過" : "否決"}）**`,
    );
  }
  lines.push("");
  lines.push("## 後續處理");
  lines.push("");
  if (passed) {
    lines.push(
      "本罷免案通過，被罷免人自本公告發布之日起解除職務（§37），選委會應於 45 日內辦理補選（§38）。",
    );
  } else {
    lines.push("本罷免案否決，依規定同一事由於同一任期內不得再為罷免案之提出（§37）。");
  }

  return { title, body: lines.join("\n") };
}

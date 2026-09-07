// 選舉稽核紀錄時間軸（純展示，唯讀）。陽春陳列：誰、何時、做了什麼、關鍵數字。
// 不做篩選／分頁／匯出——量大時直接查資料庫。
import { Badge } from "tpass-ui";
import { formatDateTime } from "@/components/public/shared";

const ACTION_LABEL: Record<string, string> = {
  advance_status: "狀態推進",
  submit_results: "提交計票結果",
  import_roster: "匯入名冊",
  remove_voter: "移除選舉人",
  hide_election: "隱藏選舉",
  restore_election: "還原選舉",
  save_public_key: "設定開票金鑰",
  publish_announcement: "發布公告",
  redo_election: "重辦選舉",
  approve_candidate: "核准候選人",
  reject_candidate: "退回候選人",
  send_back_candidate: "退回補件",
  update_election: "修改選舉設定",
  seal_election: "彌封",
  create_runoff: "建立決選",
  create_by_election: "建立補選",
  establish_recall: "罷免案成立",
  reject_recall: "罷免案不成立",
  save_recall_defense: "存答辯書",
  initiate_recall: "提起罷免",
};

export interface ElectionAuditLogRow {
  id: string;
  actorEmail: string;
  action: string;
  summary: string;
  diff: unknown;
  createdAt: Date;
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "（空）";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function ElectionAuditLogTimeline({ logs }: { logs: ElectionAuditLogRow[] }) {
  if (logs.length === 0) {
    return <p className="text-sm font-medium text-muted-foreground">尚無稽核紀錄。</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {logs.map((log) => {
        const diff = (log.diff && typeof log.diff === "object" ? log.diff : {}) as Record<string, unknown>;
        return (
          <li
            key={log.id}
            className="rounded-2xl border-2 border-foreground bg-card p-4 shadow-[3px_3px_0_0_var(--color-foreground)]"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{ACTION_LABEL[log.action] ?? log.action}</Badge>
              <span className="font-bold text-sm">{log.summary}</span>
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              {log.actorEmail} · {formatDateTime(log.createdAt)}
            </p>
            {Object.keys(diff).length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {Object.entries(diff).map(([field, value]) => (
                  <li key={field} className="text-sm">
                    <span className="font-bold">{field}</span>：
                    <span className="text-muted-foreground">{renderValue(value)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

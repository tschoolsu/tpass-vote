// 職務編輯記錄時間軸（純展示）。每筆顯示誰、何時、動作，展開看逐欄位 from→to。
import { Badge } from "tpass-ui";
import { SYSTEM_EDITOR } from "@/lib/office-upsert";

const ACTION_LABEL: Record<string, string> = {
  create: "自動建立",
  update: "自動更新",
  manual_create: "手動建立",
  manual_edit: "手動編輯",
};

const FIELD_LABEL: Record<string, string> = {
  title: "職務名稱",
  currentMembers: "現任學生",
  isVacant: "從缺狀態",
  startedAt: "入職日期",
  sourceElectionId: "來源選舉",
  termValidCount: "門檻母數(有效票)",
  note: "備註",
};

export interface OfficeEditLogRow {
  id: string;
  editorEmail: string;
  action: string;
  summary: string;
  diff: unknown;
  createdAt: Date;
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "（空）";
  if (Array.isArray(v)) {
    return (
      v
        .map((m) => (m && typeof m === "object" && "name" in m ? String((m as { name: unknown }).name) : JSON.stringify(m)))
        .join("、") || "（空）"
    );
  }
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString("zh-TW");
  return String(v);
}

export function OfficeEditLogTimeline({ logs }: { logs: OfficeEditLogRow[] }) {
  if (logs.length === 0) {
    return <p className="text-sm font-medium text-muted-foreground">尚無編輯記錄。</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {logs.map((log) => {
        const diff = (log.diff && typeof log.diff === "object" ? log.diff : {}) as Record<
          string,
          { from: unknown; to: unknown }
        >;
        const isSystem = log.editorEmail === SYSTEM_EDITOR;
        return (
          <li
            key={log.id}
            className="rounded-2xl border-2 border-foreground bg-card p-4 shadow-[3px_3px_0_0_var(--color-foreground)]"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={isSystem ? "bg-tone-violet-bg" : "bg-primary text-primary-foreground"}>
                {ACTION_LABEL[log.action] ?? log.action}
              </Badge>
              <span className="font-bold text-sm">{log.summary}</span>
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              {isSystem ? "系統（選舉公告）" : log.editorEmail} · {log.createdAt.toLocaleString("zh-TW")}
            </p>
            {Object.keys(diff).length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {Object.entries(diff).map(([field, change]) => (
                  <li key={field} className="text-sm">
                    <span className="font-bold">{FIELD_LABEL[field] ?? field}</span>：
                    <span className="text-muted-foreground">{renderValue(change.from)}</span>
                    <span className="mx-1">→</span>
                    <span className="font-medium">{renderValue(change.to)}</span>
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

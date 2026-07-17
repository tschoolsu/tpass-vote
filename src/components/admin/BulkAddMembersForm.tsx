"use client";

import { useActionState } from "react";
import { ClipboardPaste, Check, RotateCcw } from "lucide-react";
import {
  previewBulkAddAction,
  commitBulkAddAction,
  type BulkPreviewResult,
  type BulkCommitResult,
} from "@/app/admin/members/actions";
import { Button, Textarea } from "@/components/ui/primitives";

const STATUS_LABEL: Record<string, string> = {
  new: "新增",
  "already-admin": "已是管理員",
  invalid: "格式錯誤",
};

export function BulkAddMembersForm() {
  const [preview, previewAction, previewPending] = useActionState<
    BulkPreviewResult | null,
    FormData
  >(previewBulkAddAction, null);
  const [commit, commitAction, commitPending] = useActionState<
    BulkCommitResult | null,
    FormData
  >(commitBulkAddAction, null);

  if (commit?.ok) {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-xs font-bold text-primary">
          已新增 {commit.added} 位成員
          {commit.skipped ? `（略過 ${commit.skipped} 位已存在或無效）` : ""}。
        </p>
        <Button type="button" size="sm" onClick={() => window.location.reload()}>
          <RotateCcw className="h-4 w-4" /> 再匯入一批
        </Button>
      </div>
    );
  }

  if (preview?.ok && preview.rows) {
    return (
      <form action={commitAction} className="flex flex-col gap-3">
        <input type="hidden" name="rawText" value={preview.rawText} />
        <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-xl border-2 border-foreground bg-secondary p-3">
          {preview.rows.map((row) => (
            <div key={row.email} className="flex items-center justify-between gap-2 font-mono text-xs">
              <span className="truncate">{row.email}</span>
              <span
                className={
                  row.status === "new"
                    ? "font-bold text-primary"
                    : row.status === "invalid"
                      ? "font-bold text-destructive"
                      : "text-muted-foreground"
                }
              >
                {STATUS_LABEL[row.status]}
              </span>
            </div>
          ))}
        </div>
        <p className="font-mono text-xs font-bold">
          共 {preview.rows.length} 筆，{preview.newCount} 筆將新增。
        </p>
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={commitPending || preview.newCount === 0}
          >
            <Check className="h-4 w-4" /> 確認新增
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => window.location.reload()}>
            取消
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form action={previewAction} className="flex flex-col gap-2">
      <Textarea
        name="rawText"
        required
        rows={5}
        placeholder={"貼上多個 email，一行一個\nalice@tschool.tp.edu.tw\nbob@tschool.tp.edu.tw"}
        className="font-mono text-sm"
      />
      <Button type="submit" variant="primary" size="sm" disabled={previewPending}>
        <ClipboardPaste className="h-4 w-4" /> 解析預覽
      </Button>
      {preview?.error && <p className="font-mono text-xs font-bold text-destructive">{preview.error}</p>}
    </form>
  );
}

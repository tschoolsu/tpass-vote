"use client";
// 公告編輯器。同時服務兩種入口：①一般公告（legalTag 恆為 null：新建／既有清單裡那則的編輯，
// 不提供類型選擇）、②結果公告專屬（legalTag 固定傳入 "result"，只有步驟⑦「結果公告」
// 面板會用到；本編輯器已無 legalTag 選擇 UI，兩種入口的差異只在呼叫端傳的 legalTag 值）。
// 存草稿/發布都靠 id 認目標：第一次存檔後用伺服器回的 id 記住自己是誰，之後儲存變成更新
// 而不是重複新建。markdown 內文一律用 Markdown.tsx 預覽，不用 dangerouslySetInnerHTML。
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save, Megaphone, Pencil, Eye } from "lucide-react";
import { Input, Textarea, Button, Badge, Label, cn, ConfirmDialog } from "tpass-ui";
import { Markdown } from "@/components/public/Markdown";
import {
  saveAnnouncementDraft,
  publishAnnouncement,
  type ActionResult,
} from "@/app/admin/elections/[id]/announcements/actions";

export function AnnouncementEditor({
  electionId,
  id: initialId,
  legalTag = null,
  legalTagLabel,
  initialTitle = "",
  initialBody = "",
  publishedAt = null,
  publishDisabledReason,
  deadlineHint,
  onSaved,
  onDiscard,
}: {
  electionId: string;
  id?: string | null;
  /** 恆為 null＝一般公告；固定 "result"＝結果公告專屬（步驟⑦面板傳入，UI 無從改動）。 */
  legalTag?: string | null;
  legalTagLabel?: string;
  initialTitle?: string;
  initialBody?: string;
  publishedAt?: Date | null;
  publishDisabledReason?: string;
  deadlineHint?: string;
  onSaved?: (id: string) => void;
  onDiscard?: () => void;
}) {
  const router = useRouter();
  const [id, setId] = useState<string | null>(initialId ?? null);
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [publishedAtState, setPublishedAtState] = useState(publishedAt);
  const [confirmPublishOpen, setConfirmPublishOpen] = useState(false);

  function run(fn: () => Promise<ActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      setConfirmPublishOpen(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setId(result.id);
      onSaved?.(result.id);
      router.refresh();
    });
  }

  function doPublish() {
    run(async () => {
      const r = await publishAnnouncement(electionId, id, legalTag, title, body);
      if (r.ok) setPublishedAtState(new Date());
      return r;
    });
  }

  const fieldId = id ?? "new";

  return (
    <div className="flex flex-col gap-3 rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)]">
      <div className="flex flex-wrap items-center gap-2">
        <Megaphone className="h-4 w-4" />
        <h2 className="font-extrabold">{legalTagLabel ?? "一般公告"}</h2>
        {publishedAtState ? (
          <Badge className="bg-tone-green-badge text-tone-green-text">
            已發布 {publishedAtState.toLocaleString("zh-TW")}
          </Badge>
        ) : (
          <Badge className="bg-card">草稿</Badge>
        )}
      </div>
      {deadlineHint && <p className="text-xs font-medium text-muted-foreground">{deadlineHint}</p>}

      <div>
        <Label htmlFor={`${fieldId}-title`}>標題</Label>
        <Input
          id={`${fieldId}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1"
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label htmlFor={`${fieldId}-body`}>內文（markdown）</Label>
          <div className="inline-flex rounded-lg border-2 border-foreground overflow-hidden">
            <button
              type="button"
              onClick={() => setMode("write")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs font-bold",
                mode === "write" ? "bg-primary text-primary-foreground" : "bg-card",
              )}
            >
              <Pencil className="h-3 w-3" /> 撰寫
            </button>
            <button
              type="button"
              onClick={() => setMode("preview")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs font-bold border-l-2 border-foreground",
                mode === "preview" ? "bg-primary text-primary-foreground" : "bg-card",
              )}
            >
              <Eye className="h-3 w-3" /> 預覽
            </button>
          </div>
        </div>
        {mode === "write" ? (
          <Textarea
            id={`${fieldId}-body`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            className="mt-1 font-mono text-sm"
          />
        ) : (
          <div className="mt-1 min-h-24 rounded-xl border-2 border-foreground bg-secondary p-3">
            {body.trim() === "" ? (
              <p className="text-sm text-muted-foreground">（尚無內容）</p>
            ) : (
              <Markdown text={body} />
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || title.trim() === ""}
          onClick={() => run(() => saveAnnouncementDraft(electionId, id, legalTag, title, body))}
        >
          <Save className="h-4 w-4" /> 儲存草稿
        </Button>
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={pending || title.trim() === "" || Boolean(publishDisabledReason)}
          onClick={() => setConfirmPublishOpen(true)}
        >
          {publishedAtState ? "更新已發布內容" : "發布"}
        </Button>
        {onDiscard && !id && (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onDiscard}>
            取消
          </Button>
        )}
      </div>
      {publishDisabledReason && (
        <p className="text-xs font-medium text-muted-foreground">{publishDisabledReason}</p>
      )}
      {error && <p className="font-mono text-xs font-bold text-destructive">{error}</p>}
      <ConfirmDialog
        open={confirmPublishOpen}
        title={legalTag === "result" ? "確定要發布結果公告嗎？" : "確定要發布這則公告嗎？"}
        description={
          legalTag === "result"
            ? "發布後選舉會轉為「已公告結果」狀態，且當選人／罷免結果會立即生效登記到職務清單，無法回復到發布前的狀態。請先確認開票結果無誤。"
            : "發布後所有登入使用者都看得到，確定內容無誤嗎？"
        }
        confirmLabel={pending ? "處理中…" : publishedAtState ? "確定更新" : "確定發布"}
        pending={pending}
        onConfirm={doPublish}
        onCancel={() => setConfirmPublishOpen(false)}
      />
    </div>
  );
}

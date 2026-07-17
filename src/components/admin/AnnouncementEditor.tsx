"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save, Megaphone } from "lucide-react";
import { Input, Textarea, Button, Badge, Label } from "@/components/ui/primitives";
import {
  saveAnnouncementDraft,
  publishAnnouncement,
  type ActionResult,
} from "@/app/admin/elections/[id]/announcements/actions";

export function AnnouncementEditor({
  electionId,
  kind,
  kindLabel,
  initialTitle,
  initialBody,
  publishedAt,
  publishDisabledReason,
  deadlineHint,
}: {
  electionId: string;
  kind: "first" | "second" | "result";
  kindLabel: string;
  initialTitle: string;
  initialBody: string;
  publishedAt: Date | null;
  publishDisabledReason?: string;
  deadlineHint?: string;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<ActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)]">
      <div className="flex flex-wrap items-center gap-2">
        <Megaphone className="h-4 w-4" />
        <h2 className="font-extrabold">{kindLabel}</h2>
        {publishedAt ? (
          <Badge className="bg-tone-green-badge text-tone-green-text">
            已發布 {publishedAt.toLocaleString("zh-TW")}
          </Badge>
        ) : (
          <Badge className="bg-card">草稿</Badge>
        )}
      </div>
      {deadlineHint && <p className="text-xs font-medium text-muted-foreground">{deadlineHint}</p>}

      <div>
        <Label htmlFor={`${kind}-title`}>標題</Label>
        <Input
          id={`${kind}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor={`${kind}-body`}>內文（markdown）</Label>
        <Textarea
          id={`${kind}-body`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          className="mt-1 font-mono text-sm"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || title.trim() === ""}
          onClick={() => run(() => saveAnnouncementDraft(electionId, kind, title, body))}
        >
          <Save className="h-4 w-4" /> 儲存草稿
        </Button>
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={pending || title.trim() === "" || Boolean(publishDisabledReason)}
          onClick={() => run(() => publishAnnouncement(electionId, kind, title, body))}
        >
          {publishedAt ? "更新已發布內容" : "發布"}
        </Button>
      </div>
      {publishDisabledReason && (
        <p className="text-xs font-medium text-muted-foreground">{publishDisabledReason}</p>
      )}
      {error && <p className="font-mono text-xs font-bold text-destructive">{error}</p>}
    </div>
  );
}

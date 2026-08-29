"use client";
// 候選人登記表單。leader 場次固定「候選人＋副手」兩組欄位，其餘場次一組。
// 學生證影本、候選人大頭照都先 POST /api/upload 拿 upload id，送出時只帶 id（不重傳檔案內容）。
// 大頭照走 kind=photo（公開，選罷法要求選票載明相片），學生證影本走 kind=attachment（預設，私密）。
import * as React from "react";
import { UploadCloud, X, Loader2, User } from "lucide-react";
import { Button, Card, Input, Label, Textarea, cn } from "tpass-ui";
import { Markdown } from "@/components/public/Markdown";
import { registerCandidate, type RegisterInput } from "@/app/e/[slug]/register/actions";
import type { MemberInfo } from "@/components/public/shared";

type MemberField = MemberInfo;

interface AttachmentFile {
  id: string;
  filename: string;
}

const LEADER_LABELS = ["候選人", "副手"];

export function RegisterForm({
  slug,
  electionId,
  kind,
  initial,
}: {
  slug: string;
  electionId: string;
  kind: string;
  initial?: { members: MemberField[]; platform: string; attachments: AttachmentFile[] };
}) {
  const memberCount = kind === "leader" ? 2 : 1;
  const labels = kind === "leader" ? LEADER_LABELS : ["登記人"];

  const [members, setMembers] = React.useState<MemberField[]>(
    () =>
      initial?.members ??
      Array.from({ length: memberCount }, () => ({ name: "", email: "", grade: "", photo: null })),
  );
  const [platform, setPlatform] = React.useState(initial?.platform ?? "");
  const [platformTab, setPlatformTab] = React.useState<"write" | "preview">("write");
  const [attachments, setAttachments] = React.useState<AttachmentFile[]>(
    initial?.attachments ?? [],
  );
  const [uploading, setUploading] = React.useState(false);
  const [photoUploading, setPhotoUploading] = React.useState<Record<number, boolean>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const photoInputRefs = React.useRef<Record<number, HTMLInputElement | null>>({});

  function updateMember(idx: number, field: keyof Omit<MemberField, "photo">, value: string) {
    setMembers((prev) => prev.map((m, i) => (i === idx ? { ...m, [field]: value } : m)));
  }

  async function handleMemberPhoto(idx: number, file: File | null) {
    if (!file) return;
    setError(null);
    setPhotoUploading((prev) => ({ ...prev, [idx]: true }));
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("electionId", electionId);
      form.set("kind", "photo");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `大頭照上傳失敗（${res.status}）`);
      }
      const uploaded = (await res.json()) as { id: string };
      setMembers((prev) => prev.map((m, i) => (i === idx ? { ...m, photo: uploaded.id } : m)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "大頭照上傳失敗，請再試一次");
    } finally {
      setPhotoUploading((prev) => ({ ...prev, [idx]: false }));
      const input = photoInputRefs.current[idx];
      if (input) input.value = "";
    }
  }

  function removeMemberPhoto(idx: number) {
    setMembers((prev) => prev.map((m, i) => (i === idx ? { ...m, photo: null } : m)));
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("file", file);
        form.set("electionId", electionId);
        const res = await fetch("/api/upload", { method: "POST", body: form });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `上傳失敗（${res.status}）`);
        }
        const uploaded = (await res.json()) as AttachmentFile;
        setAttachments((prev) => [...prev, uploaded]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "上傳失敗，請再試一次");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (attachments.length === 0) {
      setError("請上傳至少一份學生證影本");
      return;
    }
    if (members.some((m) => !m.photo)) {
      setError("請為每位候選人上傳大頭照（選罷法規定選票需載明相片）");
      return;
    }

    const payload: RegisterInput = {
      members: members.map((m) => ({ ...m, photo: m.photo as string })),
      platform,
      attachmentIds: attachments.map((a) => a.id),
    };

    setSubmitting(true);
    try {
      const result = await registerCandidate(slug, payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuccess(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <Card className="text-center">
        <p className="font-extrabold text-lg">登記已送出，等待選委會審核</p>
        <p className="mt-1 text-sm font-medium text-muted-foreground">
          審核結果會顯示在這個頁面上方；若被要求補件，回來這裡編輯重送即可。
        </p>
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {members.map((m, idx) => (
        <Card key={idx}>
          <h3 className="font-extrabold">{labels[idx] ?? `登記人 ${idx + 1}`}</h3>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label htmlFor={`name-${idx}`}>姓名</Label>
              <Input
                id={`name-${idx}`}
                value={m.name}
                onChange={(ev) => updateMember(idx, "name", ev.target.value)}
                required
                maxLength={50}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor={`email-${idx}`}>學校信箱</Label>
              <Input
                id={`email-${idx}`}
                type="email"
                value={m.email}
                onChange={(ev) => updateMember(idx, "email", ev.target.value)}
                required
                maxLength={120}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor={`grade-${idx}`}>年級／班級</Label>
              <Input
                id={`grade-${idx}`}
                value={m.grade}
                onChange={(ev) => updateMember(idx, "grade", ev.target.value)}
                required
                maxLength={20}
                placeholder="例：高二3班"
                className="mt-1"
              />
            </div>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-foreground bg-muted">
              {m.photo ? (
                // eslint-disable-next-line @next/next/no-img-element -- 相片來自我方 /api/photos，非外部來源，不需要 next/image 的最佳化。
                <img
                  src={`/api/photos/${m.photo}`}
                  alt={`${labels[idx] ?? "登記人"}大頭照`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <User className="h-7 w-7 text-muted-foreground" />
              )}
            </div>
            <div>
              <Label>大頭照（選票需載明相片，必填）</Label>
              <p className="mt-0.5 text-xs font-medium text-muted-foreground">
                將公開顯示於選票與候選卡。接受 jpg/png/webp，單檔 10MB 以內。
              </p>
              <input
                ref={(el) => {
                  photoInputRefs.current[idx] = el;
                }}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(ev) => handleMemberPhoto(idx, ev.target.files?.[0] ?? null)}
                className="hidden"
                id={`photo-${idx}`}
              />
              <div className="mt-1.5 flex gap-2">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={photoUploading[idx]}
                  onClick={() => photoInputRefs.current[idx]?.click()}
                >
                  {photoUploading[idx] ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UploadCloud className="h-4 w-4" />
                  )}
                  {photoUploading[idx] ? "上傳中…" : m.photo ? "更換大頭照" : "上傳大頭照"}
                </Button>
                {m.photo && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeMemberPhoto(idx)}>
                    <X className="h-4 w-4" />
                    移除
                  </Button>
                )}
              </div>
            </div>
          </div>
        </Card>
      ))}

      <Card>
        <div className="flex items-center justify-between">
          <Label htmlFor="platform">政見</Label>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setPlatformTab("write")}
              className={cn(
                "rounded-md border-2 border-foreground px-2.5 py-1 font-mono text-[11px] font-bold transition-all duration-200",
                platformTab === "write"
                  ? "bg-primary text-primary-foreground shadow-[2px_2px_0_0_var(--color-foreground)]"
                  : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              撰寫
            </button>
            <button
              type="button"
              onClick={() => setPlatformTab("preview")}
              className={cn(
                "rounded-md border-2 border-foreground px-2.5 py-1 font-mono text-[11px] font-bold transition-all duration-200",
                platformTab === "preview"
                  ? "bg-primary text-primary-foreground shadow-[2px_2px_0_0_var(--color-foreground)]"
                  : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              預覽
            </button>
          </div>
        </div>

        {platformTab === "write" ? (
          <Textarea
            id="platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            required
            maxLength={4000}
            className="mt-1 min-h-40"
            placeholder="說明你的政見與訴求……"
          />
        ) : (
          <div className="mt-1 min-h-40 rounded-xl border-2 border-foreground bg-muted px-3 py-2">
            {platform.trim() === "" ? (
              <p className="text-sm font-medium text-muted-foreground">
                （尚未輸入內容，切回「撰寫」開始寫政見）
              </p>
            ) : (
              <Markdown text={platform} />
            )}
          </div>
        )}

        <p className="mt-2 text-xs font-medium text-muted-foreground">
          支援：**粗體**、# 標題、- 條列、[連結](網址)
        </p>
      </Card>

      <Card>
        <Label>學生證影本（可多張）</Label>
        <p className="mt-1 text-sm font-medium text-muted-foreground">
          供選委會核對身分，僅開放管理員檢視。接受 jpg/png/webp/pdf，單檔 10MB 以內。
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1.5 rounded-md border-2 border-foreground bg-card px-2 py-1 font-mono text-xs font-bold"
            >
              {a.filename}
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                aria-label={`移除 ${a.filename}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>

        <div className="mt-3">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(e) => handleFiles(e.target.files)}
            className="hidden"
            id="attachment-input"
          />
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            {uploading ? "上傳中…" : "選擇檔案上傳"}
          </Button>
        </div>
      </Card>

      {error && (
        <p className="rounded-xl border-2 border-destructive bg-card px-4 py-3 font-bold text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" variant="primary" disabled={submitting || uploading}>
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        送出登記
      </Button>
    </form>
  );
}

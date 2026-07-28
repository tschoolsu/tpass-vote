"use client";
// 職務新增／編輯表單。現任學生為動態列表（聯名可多人），從缺時清空並停用入職日。
// 直接呼叫 server action 傳結構化 payload（比照 RegisterForm），不走 form action 序列化巢狀資料。
import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Loader2 } from "lucide-react";
import { Button, Card, Input, Label, Textarea } from "@/components/ui/primitives";
import { createOffice, updateOffice, type OfficeInput, type OfficeMemberInput } from "@/app/admin/offices/actions";

type MemberRow = { name: string; email: string; grade: string };

function toDateInputValue(d: Date | null | undefined): string {
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function OfficeForm({
  mode,
  officeId,
  initial,
}: {
  mode: "create" | "edit";
  officeId?: string;
  initial?: {
    title: string;
    members: OfficeMemberInput[];
    isVacant: boolean;
    startedAt: Date | null;
    note: string | null;
  };
}) {
  const router = useRouter();
  const [title, setTitle] = React.useState(initial?.title ?? "");
  const [members, setMembers] = React.useState<MemberRow[]>(
    () =>
      (initial?.members ?? []).map((m) => ({ name: m.name, email: m.email ?? "", grade: m.grade ?? "" })) || [],
  );
  const [isVacant, setIsVacant] = React.useState(initial?.isVacant ?? false);
  const [startedAt, setStartedAt] = React.useState(toDateInputValue(initial?.startedAt));
  const [note, setNote] = React.useState(initial?.note ?? "");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function updateMember(idx: number, field: keyof MemberRow, value: string) {
    setMembers((prev) => prev.map((m, i) => (i === idx ? { ...m, [field]: value } : m)));
  }
  function addMember() {
    setMembers((prev) => [...prev, { name: "", email: "", grade: "" }]);
  }
  function removeMember(idx: number) {
    setMembers((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const payload: OfficeInput = {
      title,
      members: members.map((m) => ({ name: m.name, email: m.email, grade: m.grade })),
      isVacant,
      startedAt: startedAt || null,
      note: note.trim() || null,
    };
    setSubmitting(true);
    try {
      const result =
        mode === "create" ? await createOffice(payload) : await updateOffice(officeId!, payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/admin/offices/${result.officeId}`);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="office-title">職務名稱</Label>
        <Input
          id="office-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={100}
          placeholder="例：學生會長"
          className="mt-1"
        />
      </div>

      <label className="flex items-center gap-2 font-bold text-sm">
        <input type="checkbox" checked={isVacant} onChange={(e) => setIsVacant(e.target.checked)} />
        此職務目前從缺
      </label>

      {!isVacant && (
        <>
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label>現任學生（聯名可多人）</Label>
              <Button type="button" size="sm" onClick={addMember}>
                <Plus className="h-3.5 w-3.5" /> 新增一人
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              {members.map((m, idx) => (
                <Card key={idx} className="p-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div>
                      <Label htmlFor={`m-name-${idx}`} className="text-xs">姓名</Label>
                      <Input id={`m-name-${idx}`} value={m.name} onChange={(e) => updateMember(idx, "name", e.target.value)} maxLength={50} className="mt-1" />
                    </div>
                    <div>
                      <Label htmlFor={`m-email-${idx}`} className="text-xs">學校信箱（選填）</Label>
                      <Input id={`m-email-${idx}`} type="email" value={m.email} onChange={(e) => updateMember(idx, "email", e.target.value)} maxLength={120} className="mt-1" />
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <Label htmlFor={`m-grade-${idx}`} className="text-xs">年級／班級（選填）</Label>
                        <Input id={`m-grade-${idx}`} value={m.grade} onChange={(e) => updateMember(idx, "grade", e.target.value)} maxLength={20} className="mt-1" />
                      </div>
                      <Button type="button" variant="ghost" size="sm" onClick={() => removeMember(idx)} aria-label="移除這位">
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
              {members.length === 0 && (
                <p className="text-sm font-medium text-muted-foreground">尚未加入現任學生，點「新增一人」。</p>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="office-started">入職日期</Label>
            <Input id="office-started" type="date" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} className="mt-1" />
            <p className="mt-1 text-xs text-muted-foreground">影響罷免「就職滿 2 個月」的判定。</p>
          </div>
        </>
      )}

      <div>
        <Label htmlFor="office-note">備註（選填）</Label>
        <Textarea id="office-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="mt-1 min-h-20" />
      </div>

      {error && <p className="font-mono text-sm font-bold text-destructive">{error}</p>}

      <Button type="submit" variant="primary" disabled={submitting}>
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {mode === "create" ? "建立職務" : "儲存變更"}
      </Button>
    </form>
  );
}

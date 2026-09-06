"use client";
// 選舉建立／編輯共用表單。new/page.tsx 與 [id]/edit/page.tsx 都用這份，
// 差別只在傳入的 server action 與初始值——驗證規則集中在 election-schema.ts，這裡不重寫規則。
import { useActionState, useEffect, useRef, useState } from "react";
import { Input, Select, Label, Button } from "tpass-ui";
import {
  ELECTION_KINDS,
  ELECTION_KIND_LABEL,
  toDatetimeLocalValue,
  type ElectionFormResult,
  type ElectionFormValues,
} from "@/app/admin/elections/election-schema";

// slug 建議規則：標題裡有可用的英數字就轉成 slug；中文標題轉不出英文，
// 退回「年份 + 類型」的樣板（例如 2026-leader）。只在新增模式、且使用者
// 還沒手動編輯過 slug 欄位時套用，不覆蓋既有選舉或使用者已打的字。
const KIND_SLUG_PART: Record<ElectionFormValues["kind"], string> = {
  leader: "leader",
  grade_rep: "grade-rep",
  other: "election",
};

function suggestSlug(title: string, kind: ElectionFormValues["kind"]): string {
  const year = new Date().getFullYear();
  const latinPart = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = latinPart.length >= 2 ? `${year}-${latinPart}` : `${year}-${KIND_SLUG_PART[kind]}`;
  return base.slice(0, 50).replace(/-+$/, "");
}

export interface ElectionFormInitial {
  title?: string;
  slug?: string;
  kind?: ElectionFormValues["kind"];
  seats?: number;
  maxChoices?: number;
  registrationStartsAt?: Date | null;
  registrationEndsAt?: Date | null;
  votingStartsAt?: Date | null;
  votingEndsAt?: Date | null;
  officeId?: string | null;
}

export function ElectionForm({
  mode,
  action,
  initial,
  offices = [],
  onSuccess,
}: {
  mode: "create" | "edit";
  action: (prev: ElectionFormResult | null, formData: FormData) => Promise<ElectionFormResult>;
  initial?: ElectionFormInitial;
  offices?: { id: string; title: string }[];
  onSuccess: (result: ElectionFormResult) => void;
}) {
  const [state, formAction, pending] = useActionState<ElectionFormResult | null, FormData>(
    action,
    null,
  );

  useEffect(() => {
    if (state?.ok) onSuccess(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const fe = state?.fieldErrors ?? {};
  const sv = state?.values;

  // slug 自動建議：edit 模式或已有初始 slug 就當作「使用者已決定」，不自動改動（會動到既有網址）。
  const slugRef = useRef<HTMLInputElement>(null);
  const [slugEdited, setSlugEdited] = useState(mode === "edit" || Boolean(initial?.slug));
  const [titleValue, setTitleValue] = useState(sv?.title ?? initial?.title ?? "");
  const [kindValue, setKindValue] = useState<ElectionFormValues["kind"]>(
    (sv?.kind as ElectionFormValues["kind"] | undefined) ?? initial?.kind ?? "leader",
  );
  const [maxChoicesValue, setMaxChoicesValue] = useState<number>(
    Number(sv?.maxChoices ?? initial?.maxChoices ?? 1),
  );

  useEffect(() => {
    if (mode !== "create" || slugEdited || !titleValue.trim()) return;
    if (slugRef.current) slugRef.current.value = suggestSlug(titleValue, kindValue);
  }, [mode, slugEdited, titleValue, kindValue]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="title">選舉名稱</Label>
        <Input
          id="title"
          name="title"
          required
          defaultValue={sv?.title ?? initial?.title}
          onChange={(e) => setTitleValue(e.target.value)}
          className="mt-1"
        />
        {fe.title && <p role="alert" className="mt-1 font-mono text-xs font-bold text-destructive">{fe.title}</p>}
      </div>

      <div>
        <Label htmlFor="slug">slug（網址代稱）</Label>
        <Input
          ref={slugRef}
          id="slug"
          name="slug"
          required
          defaultValue={sv?.slug ?? initial?.slug}
          onChange={() => setSlugEdited(true)}
          placeholder="2026-student-leader"
          className="mt-1 font-mono"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {mode === "create"
            ? "只能是小寫英數與連字號，需唯一，投票網址為 /e/<slug>。已依標題預填建議值，可直接改。"
            : "只能是小寫英數與連字號，需唯一，投票網址為 /e/<slug>。"}
        </p>
        {fe.slug && <p role="alert" className="mt-1 font-mono text-xs font-bold text-destructive">{fe.slug}</p>}
      </div>

      <div>
        <Label htmlFor="kind">類型</Label>
        <Select
          id="kind"
          name="kind"
          required
          defaultValue={sv?.kind ?? initial?.kind ?? "leader"}
          onChange={(e) => setKindValue(e.target.value as ElectionFormValues["kind"])}
          className="mt-1"
        >
          {ELECTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {ELECTION_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
        {fe.kind && <p role="alert" className="mt-1 font-mono text-xs font-bold text-destructive">{fe.kind}</p>}
      </div>

      <div>
        <Label htmlFor="officeId">對應職務（選填）</Label>
        <Select id="officeId" name="officeId" defaultValue={sv?.officeId ?? initial?.officeId ?? ""} className="mt-1">
          <option value="">新職務（公告結果時自動建立）</option>
          {offices.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}（連任／補選：公告時更新此職務現任）
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-muted-foreground">
          留空＝這是全新職務。若是既有職務的改選或罷免補選，選對應職務，公告結果時會更新那筆的現任與入職日。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="seats">名額</Label>
          <Input
            id="seats"
            name="seats"
            type="number"
            min={1}
            required
            defaultValue={sv?.seats ?? initial?.seats ?? 1}
            className="mt-1"
          />
          {fe.seats && <p role="alert" className="mt-1 font-mono text-xs font-bold text-destructive">{fe.seats}</p>}
        </div>
        <div>
          <Label htmlFor="maxChoices">每票最多可選（多選模式用）</Label>
          <Input
            id="maxChoices"
            name="maxChoices"
            type="number"
            min={1}
            required
            defaultValue={sv?.maxChoices ?? initial?.maxChoices ?? 1}
            onChange={(e) => setMaxChoicesValue(Number(e.target.value))}
            className="mt-1"
          />
          {fe.maxChoices && (
            <p role="alert" className="mt-1 font-mono text-xs font-bold text-destructive">{fe.maxChoices}</p>
          )}
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            學生代表採單記不可讓渡（§13），只能填 1。
          </p>
          {kindValue !== "grade_rep" && maxChoicesValue > 1 && (
            <p role="alert" className="mt-1 font-mono text-xs font-bold text-destructive">
              每票可圈選多人＝連記投票，年級代表選舉依選罷法 §13 必須為 1
            </p>
          )}
        </div>
      </div>

      <fieldset className="rounded-xl border-2 border-foreground p-3">
        <legend className="px-1 font-bold text-sm">候選人登記期間（選填）</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="registrationStartsAt">開始</Label>
            <Input
              id="registrationStartsAt"
              name="registrationStartsAt"
              type="datetime-local"
              defaultValue={sv?.registrationStartsAt ?? toDatetimeLocalValue(initial?.registrationStartsAt)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="registrationEndsAt">結束</Label>
            <Input
              id="registrationEndsAt"
              name="registrationEndsAt"
              type="datetime-local"
              defaultValue={sv?.registrationEndsAt ?? toDatetimeLocalValue(initial?.registrationEndsAt)}
              className="mt-1"
            />
            {fe.registrationEndsAt && (
              <p role="alert" className="mt-1 font-mono text-xs font-bold text-destructive">{fe.registrationEndsAt}</p>
            )}
          </div>
        </div>
      </fieldset>

      <fieldset className="rounded-xl border-2 border-foreground p-3">
        <legend className="px-1 font-bold text-sm">投票期間</legend>
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          開放投票前必須填妥，且不得少於 48 小時（§26-1 Ⅱ）。
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="votingStartsAt">開始</Label>
            <Input
              id="votingStartsAt"
              name="votingStartsAt"
              type="datetime-local"
              defaultValue={sv?.votingStartsAt ?? toDatetimeLocalValue(initial?.votingStartsAt)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="votingEndsAt">結束</Label>
            <Input
              id="votingEndsAt"
              name="votingEndsAt"
              type="datetime-local"
              defaultValue={sv?.votingEndsAt ?? toDatetimeLocalValue(initial?.votingEndsAt)}
              className="mt-1"
            />
            {fe.votingEndsAt && (
              <p role="alert" className="mt-1 font-mono text-xs font-bold text-destructive">{fe.votingEndsAt}</p>
            )}
          </div>
        </div>
      </fieldset>

      {state?.error && !state.ok && (
        <p role="alert" className="font-mono text-sm font-bold text-destructive">{state.error}</p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "處理中…" : mode === "create" ? "建立選舉，下一步產生金鑰" : "儲存變更"}
      </Button>
    </form>
  );
}

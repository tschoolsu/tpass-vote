"use client";

import { useActionState } from "react";
import { UserPlus } from "lucide-react";
import { addAdminAction, type MemberResult } from "@/app/admin/members/actions";
import { Input, Button } from "@/components/ui/primitives";

export function AddMemberForm() {
  const [state, action, pending] = useActionState<MemberResult | null, FormData>(
    addAdminAction,
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          name="email"
          type="email"
          required
          placeholder="member@tschool.tp.edu.tw"
          className="flex-1"
        />
        <Button type="submit" variant="primary" disabled={pending}>
          <UserPlus className="h-4 w-4" /> 新增
        </Button>
      </div>
      {state?.error && <p className="font-mono text-xs font-bold text-destructive">{state.error}</p>}
      {state?.ok && <p className="font-mono text-xs font-bold text-primary">已新增管理員。</p>}
    </form>
  );
}

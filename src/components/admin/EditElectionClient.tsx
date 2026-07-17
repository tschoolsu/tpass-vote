"use client";

import { useRouter } from "next/navigation";
import { ElectionForm, type ElectionFormInitial } from "@/components/admin/ElectionForm";
import type { ElectionFormResult } from "@/app/admin/elections/election-schema";

export function EditElectionClient({
  electionId,
  initial,
  action,
}: {
  electionId: string;
  initial: ElectionFormInitial;
  action: (prev: ElectionFormResult | null, formData: FormData) => Promise<ElectionFormResult>;
}) {
  const router = useRouter();
  return (
    <ElectionForm
      mode="edit"
      action={action}
      initial={initial}
      onSuccess={() => router.push(`/admin/elections/${electionId}`)}
    />
  );
}

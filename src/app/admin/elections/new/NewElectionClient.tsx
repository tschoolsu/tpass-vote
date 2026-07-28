"use client";
// 建立選舉分兩步：先送出基本資料（無公鑰），成功後在同一頁接著跑金鑰產生精靈。
// 私鑰全程只在瀏覽器（KeyGenPanel），這裡只負責串接兩步的畫面切換。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ElectionForm } from "@/components/admin/ElectionForm";
import { KeyGenPanel } from "@/components/admin/KeyGenPanel";
import { createElection } from "./actions";
import type { ElectionFormResult } from "@/app/admin/elections/election-schema";

export function NewElectionClient({ offices }: { offices: { id: string; title: string }[] }) {
  const router = useRouter();
  const [created, setCreated] = useState<{ id: string; slug: string } | null>(null);

  if (created) {
    return (
      <div className="max-w-xl">
        <h1 className="font-extrabold text-2xl tracking-tight mb-1">產生開票金鑰</h1>
        <p className="mb-6 font-medium text-muted-foreground">
          選舉「{created.slug}」已建立為草稿。最後一步：產生本場的開票金鑰。
        </p>
        <KeyGenPanel
          electionId={created.id}
          slug={created.slug}
          onSaved={() => router.push(`/admin/elections/${created.id}`)}
        />
      </div>
    );
  }

  return (
    <div className="max-w-xl">
      <h1 className="font-extrabold text-2xl tracking-tight mb-6">新增選舉</h1>
      <ElectionForm
        mode="create"
        action={createElection}
        offices={offices}
        onSuccess={(result: ElectionFormResult) => {
          if (result.electionId && result.slug) {
            setCreated({ id: result.electionId, slug: result.slug });
          }
        }}
      />
    </div>
  );
}

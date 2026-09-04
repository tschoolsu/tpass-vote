"use client";
// 開票頁主體。全程在瀏覽器執行：讀金鑰檔 → 本地解密 → 計票 → 顯示結果 → 送出「結果」給伺服器
// （伺服器只收計票結果數字，收不到金鑰、也看不到任何一張選票內容）。
// 金鑰檔內容只存在這個 component 的 state；一離開頁面（或按「清除」）就沒了，不寫 localStorage/cookie。
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Lock,
  Upload,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RefreshCcw,
  Send,
  Users2,
} from "lucide-react";
import { Button, Card, Badge } from "tpass-ui";
import type { TallyKeyFile } from "@/lib/ballot-crypto";
import { decryptAndTally, type TallyMeta } from "@/lib/tally-client";
import type { TallyResult } from "@/lib/tally";
import type { DisclosureEntry } from "@/lib/disclosure";
import { submitResults } from "@/app/admin/elections/[id]/tally/actions";
import { createRunoff } from "@/app/admin/elections/[id]/actions";

type Stage = "idle" | "loaded" | "result" | "submitted";

export function TallyClient({
  electionId,
  slug,
  sealedBox,
  sealedHash,
  keyShares,
  alreadySubmitted,
  meta,
  candidateLabels,
}: {
  electionId: string;
  slug: string;
  sealedBox: string[];
  sealedHash: string | null;
  keyShares: number;
  alreadySubmitted: boolean;
  meta: TallyMeta;
  candidateLabels: Record<string, string>;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [keyFiles, setKeyFiles] = useState<TallyKeyFile[]>([]);
  const [result, setResult] = useState<TallyResult | null>(null);
  // §26-1 Ⅳ/Ⅴ 要公告的代碼↔意思明細，與 result 同時產生、同時提交。
  const [disclosures, setDisclosures] = useState<DisclosureEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [runoffMsg, setRunoffMsg] = useState<string | null>(null);

  async function handleFiles(fileList: FileList | null) {
    setError(null);
    if (!fileList || fileList.length === 0) return;
    try {
      const files = await Promise.all(
        Array.from(fileList).map(async (f) => JSON.parse(await f.text()) as TallyKeyFile),
      );
      setKeyFiles(files);
      setStage("loaded");
    } catch {
      setError("金鑰檔案格式錯誤，無法解析（請確認選對了 .json 金鑰檔）");
    }
  }

  function handleDecrypt() {
    setError(null);
    startTransition(async () => {
      try {
        const r = await decryptAndTally(keyFiles, sealedBox, meta);
        setResult(r.results);
        setDisclosures(r.disclosures);
        setStage("result");
      } catch (e) {
        setError(e instanceof Error ? e.message : "解密失敗，請確認金鑰檔正確且齊全");
      }
    });
  }

  function handleReset() {
    setKeyFiles([]);
    setResult(null);
    setDisclosures(null);
    setError(null);
    setStage("idle");
  }

  function handleSubmit() {
    if (!result || !disclosures) return;
    setSubmitMsg(null);
    startTransition(async () => {
      const r = await submitResults(electionId, result, disclosures);
      if (!r.ok) {
        setSubmitMsg(`提交失敗：${r.error}`);
        return;
      }
      setSubmitMsg("計票結果已提交，請到「公告」頁面發布結果公告。");
      setStage("submitted");
      router.refresh();
    });
  }

  function handleCreateRunoff() {
    if (!result) return;
    const tiedIds = result.candidates.filter((c) => c.tied).map((c) => c.candidateId);
    setRunoffMsg(null);
    startTransition(async () => {
      const r = await createRunoff(electionId, tiedIds);
      if (!r.ok) {
        setRunoffMsg(`建立重選場次失敗：${r.error}`);
        return;
      }
      router.push(`/admin/elections/${r.electionId}`);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Lock className="h-5 w-5" />
          <h2 className="font-extrabold">彌封快照</h2>
        </div>
        <p className="font-mono text-xs text-muted-foreground break-all">
          sealedHash：{sealedHash ?? "（無）"}
        </p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          票匭張數：{sealedBox.length} · 開票金鑰分持：{keyShares} 份
        </p>
        {alreadySubmitted && (
          <p className="mt-2 flex items-center gap-1.5 font-bold text-sm text-tone-blue-text">
            <CheckCircle2 className="h-4 w-4" /> 此選舉已提交過計票結果，重新計票並提交會覆蓋原結果。
          </p>
        )}
      </Card>

      <Card>
        <div className="flex items-center gap-2 mb-3">
          <Upload className="h-5 w-5" />
          <h2 className="font-extrabold">載入開票金鑰檔</h2>
        </div>
        <div className="mb-3 flex items-start gap-2 rounded-xl border-2 border-foreground bg-tone-rose-bg p-3 text-tone-rose-text">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
          <p className="font-bold text-sm">
            請只在你信任的裝置上進行開票。金鑰檔一旦讀入這個頁面就會在記憶體中解密選票，
            離開或重新整理頁面即清除，不會被寫入硬碟或送到伺服器。
          </p>
        </div>
        <input
          type="file"
          multiple
          accept="application/json"
          onChange={(e) => handleFiles(e.target.files)}
          className="block w-full text-sm font-medium"
        />
        {keyFiles.length > 0 && (
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            已載入 {keyFiles.length} 份金鑰檔（election={keyFiles[0]?.election ?? "?"}）
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="primary"
            disabled={keyFiles.length === 0 || busy}
            onClick={handleDecrypt}
          >
            {busy && stage !== "result" ? "解密計票中…" : "開始解密計票"}
          </Button>
          <Button type="button" variant="ghost" onClick={handleReset} disabled={keyFiles.length === 0}>
            <RefreshCcw className="h-4 w-4" /> 清除金鑰檔
          </Button>
        </div>
        {error && <p className="mt-2 font-mono text-xs font-bold text-destructive">{error}</p>}
        <p className="mt-2 font-mono text-[11px] text-muted-foreground">選舉 slug：{slug}</p>
      </Card>

      {result && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <Users2 className="h-5 w-5" />
            <h2 className="font-extrabold">計票結果</h2>
            <Badge className="bg-card">{result.mode === "choose" ? "超額（choose）" : "同額（approval）"}</Badge>
          </div>

          <p className="mb-3 font-mono text-xs text-muted-foreground">
            總票數 {result.totalBallots} · 有效 {result.validCount} · 廢票 {result.blankCount} · 無效{" "}
            {result.invalidCount} · 選舉人 {result.rosterCount} · 投票率 {result.turnoutPct}%
          </p>
          <p className="mb-3 font-mono text-xs text-muted-foreground">
            將一併提交 {disclosures?.length ?? 0} 筆去識別化選票明細（代碼↔意思），隨結果公告公開（§26-1 Ⅳ、Ⅴ）。
          </p>

          {result.hasTie && (
            <div className="mb-3 flex items-start gap-2 rounded-xl border-2 border-foreground bg-tone-orange-bg p-3 text-tone-orange-text">
              <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-sm">席次邊界出現同票，系統不裁決，需選委會決議重選。</p>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="mt-2"
                  disabled={busy}
                  onClick={handleCreateRunoff}
                >
                  建立重選場次
                </Button>
                {runoffMsg && <p className="mt-1 font-mono text-xs font-bold">{runoffMsg}</p>}
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-foreground text-left font-bold">
                  <th className="py-1.5 pr-2">候選人</th>
                  <th className="py-1.5 pr-2">{result.mode === "approval" ? "同意" : "得票"}</th>
                  {result.mode === "approval" && <th className="py-1.5 pr-2">不同意</th>}
                  <th className="py-1.5 pr-2">結果</th>
                </tr>
              </thead>
              <tbody>
                {result.candidates.map((c) => (
                  <tr key={c.candidateId} className="border-b border-foreground/20">
                    <td className="py-1.5 pr-2 font-medium">{candidateLabels[c.candidateId] ?? c.candidateId}</td>
                    <td className="py-1.5 pr-2 font-mono">{c.votes}</td>
                    {result.mode === "approval" && <td className="py-1.5 pr-2 font-mono">{c.disagree}</td>}
                    <td className="py-1.5 pr-2">
                      {c.tied ? (
                        <Badge className="bg-tone-orange-badge text-tone-orange-text">同票</Badge>
                      ) : c.elected ? (
                        <span className="inline-flex items-center gap-1 font-bold text-tone-green-text">
                          <CheckCircle2 className="h-4 w-4" /> 當選
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <XCircle className="h-4 w-4" /> 未當選
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4">
            <Button type="button" variant="primary" disabled={busy} onClick={handleSubmit}>
              <Send className="h-4 w-4" /> {busy ? "提交中…" : "提交計票結果"}
            </Button>
            {submitMsg && <p className="mt-2 font-mono text-xs font-bold">{submitMsg}</p>}
          </div>
        </Card>
      )}
    </div>
  );
}

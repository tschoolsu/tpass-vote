"use client";
// 開票金鑰產生精靈。全程在瀏覽器執行，私鑰與金鑰檔內容絕不送往伺服器——
// 送給 savePublicKey 的只有 publicKeyJwk（公鑰）與 shares（份數這個數字本身）。
// 用完（存檔成功）即清掉 state，不寫 localStorage/cookie。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Download, AlertTriangle, CheckCircle2 } from "lucide-react";
import { generateTallyKeyPair, makeKeyFiles, type TallyKeyFile } from "@/lib/ballot-crypto";
import { DEFAULT_KEY_SHARES, canConfirmShare, canSubmitKeys, type ShareGateState } from "@/lib/keygen-gate";
import { Button } from "tpass-ui";
import { savePublicKey } from "@/app/admin/elections/[id]/actions";

function downloadKeyFile(file: TallyKeyFile) {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tvote-key-${file.election}-share${file.share}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

type Step = "choose" | "generated" | "saved";

export function KeyGenPanel({
  electionId,
  slug,
  onSaved,
}: {
  electionId: string;
  slug: string;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("choose");
  const [shares, setShares] = useState<1 | 2>(DEFAULT_KEY_SHARES);
  const [generating, setGenerating] = useState(false);
  const [keyFiles, setKeyFiles] = useState<TallyKeyFile[] | null>(null);
  const [publicKeyJwk, setPublicKeyJwk] = useState<JsonWebKey | null>(null);
  // 每一份金鑰檔各自的下載/確認狀態，key 是 share 編號（1-based）。
  const [gate, setGate] = useState<Record<number, ShareGateState>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const { publicKeyJwk: pub, privateKeyJwk } = await generateTallyKeyPair();
      const files = makeKeyFiles(privateKeyJwk, slug, shares);
      setPublicKeyJwk(pub);
      setKeyFiles(files);
      setGate(Object.fromEntries(files.map((f) => [f.share, { downloaded: false, confirmed: false }])));
      setStep("generated");
    } catch {
      setError("金鑰產生失敗，請重新整理頁面再試一次");
    } finally {
      setGenerating(false);
    }
  }

  function handleDownload(file: TallyKeyFile) {
    downloadKeyFile(file);
    setGate((g) => ({ ...g, [file.share]: { ...g[file.share], downloaded: true } }));
  }

  function handleConfirm(share: number, value: boolean) {
    setGate((g) => ({ ...g, [share]: { ...g[share], confirmed: value } }));
  }

  async function handleSave() {
    if (!publicKeyJwk || !keyFiles || !canSubmitKeys(Object.values(gate))) return;
    setSaving(true);
    setError(null);
    const result = await savePublicKey(electionId, publicKeyJwk, shares);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setStep("saved");
    setPublicKeyJwk(null);
    setKeyFiles(null);
    router.refresh();
    onSaved?.();
  }

  if (step === "saved") {
    return (
      <div className="flex items-center gap-2 rounded-2xl border-2 border-foreground bg-tone-green-bg p-4 font-bold text-tone-green-text shadow-[3px_3px_0_0_var(--color-foreground)]">
        <CheckCircle2 className="h-5 w-5 shrink-0" /> 開票公鑰已儲存，私鑰只存在你剛下載的金鑰檔中。
      </div>
    );
  }

  return (
    <div className="rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)]">
      <div className="flex items-center gap-2 mb-3">
        <KeyRound className="h-5 w-5" />
        <h2 className="font-extrabold">產生開票金鑰</h2>
      </div>

      <div className="mb-4 flex items-start gap-2 rounded-xl border-2 border-foreground bg-tone-rose-bg p-3 text-tone-rose-text">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
        <p className="font-bold text-sm">
          金鑰檔弄丟＝這場選舉永遠無法開票，只能重辦選舉。私鑰只存在你即將下載的金鑰檔裡，
          伺服器只存公鑰，選委會沒有任何後路可以救回遺失的金鑰。若日後真的遺失，回到本場「設定」
          面板或「截止與開票」面板使用「作廢並重辦」建立新場次（新場次一樣要重新產生金鑰）。
        </p>
      </div>

      {step === "choose" && (
        <>
          <p className="font-bold text-sm mb-2">選擇分持份數</p>
          <div className="flex flex-col gap-2 mb-4">
            <label className="flex items-start gap-2 rounded-xl border-2 border-foreground bg-secondary p-3 cursor-pointer">
              <input
                type="radio"
                name="shares"
                className="mt-1"
                checked={shares === 1}
                onChange={() => setShares(1)}
              />
              <span>
                <span className="block font-bold text-sm">1 份（單人保管）</span>
                <span className="block text-xs text-muted-foreground">
                  一份金鑰檔即可開票，等於放棄 SOP 要求的雙人獨立開票比對；該選委離職/遺失檔案即無法開票。
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-xl border-2 border-foreground bg-secondary p-3 cursor-pointer">
              <input
                type="radio"
                name="shares"
                className="mt-1"
                checked={shares === 2}
                onChange={() => setShares(2)}
              />
              <span>
                <span className="block font-bold text-sm">2 份分持（雙人保管）</span>
                <span className="block text-xs text-muted-foreground">
                  兩份金鑰檔各自都不含可用資訊，開票時必須兩份同時在場才能解密。
                  任一份遺失，一樣永遠無法開票——不是備援，是雙人授權。
                </span>
              </span>
            </label>
          </div>
          <Button type="button" variant="primary" disabled={generating} onClick={handleGenerate}>
            <KeyRound className="h-4 w-4" /> {generating ? "產生中…" : "產生金鑰"}
          </Button>
        </>
      )}

      {step === "generated" && keyFiles && (
        <>
          <p className="font-bold text-sm mb-2">
            已產生 {keyFiles.length} 份金鑰檔，請逐份點擊下載並分別交給不同選委保管（例如存到不同裝置）：
          </p>
          <ul className="flex flex-col gap-2 mb-4">
            {keyFiles.map((f) => {
              const state = gate[f.share] ?? { downloaded: false, confirmed: false };
              return (
                <li
                  key={f.share}
                  className="flex flex-col gap-2 rounded-xl border-2 border-foreground bg-secondary px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-bold">
                      tvote-key-{f.election}-share{f.share}.json
                    </span>
                    <Button type="button" size="sm" onClick={() => handleDownload(f)}>
                      <Download className="h-3.5 w-3.5" /> 下載第 {f.share} 份
                    </Button>
                  </div>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={!canConfirmShare(state)}
                      checked={state.confirmed}
                      onChange={(e) => handleConfirm(f.share, e.target.checked)}
                    />
                    <span className="font-bold text-sm">
                      我已下載並妥善保管第 {f.share} 份，了解遺失即無法開票。
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          <Button
            type="button"
            variant="primary"
            disabled={!canSubmitKeys(Object.values(gate)) || saving}
            onClick={handleSave}
          >
            {saving ? "儲存中…" : "確認並儲存公鑰"}
          </Button>
        </>
      )}

      {error && <p role="alert" className="mt-3 font-mono text-xs font-bold text-destructive">{error}</p>}
    </div>
  );
}

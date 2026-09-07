// D11-1（第 2 輪）：approval 模式大場次（3000 票 × 9 候選人 ≈ 1.1MB）的
// submitResults 在進 action 前就被 Next 預設的 1MB server action body 上限擋成 413，
// TallyClient 沒 try/catch，選委看到整頁錯誤。next.config.ts 要把上限放寬到 8mb。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

describe("D11-1：next.config.ts 放寬 server action body 上限", () => {
  it("experimental.serverActions.bodySizeLimit 設為 8mb，不吃 Next 預設 1MB", () => {
    const config = readFileSync(path.join(repoRoot, "next.config.ts"), "utf8");
    expect(config).toMatch(/experimental\s*:\s*{[\s\S]*?serverActions\s*:\s*{[\s\S]*?bodySizeLimit\s*:\s*["']8mb["']/);
  });
});

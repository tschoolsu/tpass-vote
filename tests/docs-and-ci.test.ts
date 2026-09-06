// C-5：三個選舉前排查發現，各配一個「笨但清楚」的迴歸測試。
//
// - CI 不驗 migration 對空庫能否套用、不驗 ecosystem.config.js 存在
//   （見 tests/audit/D10-5-slow-auth-and-drain.test.ts 的註解：deploy.sh 會因缺這個檔拒絕部署，
//   但 CI 從沒抓過）。這裡不跑真的 CI，只驗 workflow 檔裡確實有這兩個查核步驟。
// - GITHUB_URL 指到個人帳號 repo，真相是 tschoolsu 組織（git remote 已經是 tschoolsu）。
// - 收據查詢查到已被覆寫的舊代碼時，只說「查無此收據」，沒提示「重投會讓舊代碼失效」。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

describe("C-5：CI 補查核 + 文件與文案修正", () => {
  it("ci.yml 有一個 job 會對空庫跑 prisma migrate deploy，並檢查 ecosystem.config.js 存在", () => {
    const ci = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/prisma migrate deploy/);
    expect(ci).toMatch(/test -f ecosystem\.config\.js/);
    // 這個 job 要真的起一個 postgres service 才能叫「對空庫套用」，不是對假 DATABASE_URL 空跑。
    expect(ci).toMatch(/image:\s*postgres/);
  });

  it("migrate deploy 步驟的註解不誇稱能抓到 migrations 跟 schema.prisma 的落差", () => {
    // prisma migrate deploy 只驗「這批 migration SQL 套不套得起來」，不讀 datamodel，
    // 抓不到「schema 改了但沒產生對應 migration」這種 9/2 事故那類分岔。
    // 之前的註解宣稱它會抓「跟 schema 對不上」，實測反例：對 schema.prisma 加一個
    // 沒有對應 migration 的 model，migrate deploy 仍 exit 0 全數套用——註解與行為不符。
    const ci = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(ci).not.toMatch(/跟 schema 對不上/);
  });

  it("GITHUB_URL 指向 tschoolsu 組織 repo，不是個人帳號", () => {
    const site = readFileSync(path.join(repoRoot, "src/config/site.ts"), "utf8");
    expect(site).toContain("github.com/tschoolsu/tpass-vote");
    expect(site).not.toContain("github.com/YC815");
  });

  it("ReceiptLookup 的查無此收據文案提醒使用者重投後舊代碼已失效", () => {
    const component = readFileSync(
      path.join(repoRoot, "src/components/public/ReceiptLookup.tsx"),
      "utf8",
    );
    const missingBlock = component.slice(component.indexOf('"missing"'));
    expect(missingBlock).toMatch(/重投/);
    expect(missingBlock).toMatch(/最後一次/);
  });
});

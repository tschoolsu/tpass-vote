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

  // 一人一票之後，「查無此收據」最常見的原因不再是重投，而是「在確認頁看過代碼但沒按送出」——
  // 代碼是進確認頁時就產生並顯示的，沒送出的那組不會生效。文案要講到這件事，不然使用者
  // 只會以為自己抄錯，然後發現自己也不能再投一次。
  it("ReceiptLookup 的查無此收據文案要解釋「沒送出的代碼不生效」", () => {
    const component = readFileSync(
      path.join(repoRoot, "src/components/public/ReceiptLookup.tsx"),
      "utf8",
    );
    const missingBlock = component.slice(component.indexOf('"missing"'));
    expect(missingBlock).toMatch(/抄錯|輸入錯/);
    expect(missingBlock).toMatch(/沒有按下送出|沒有送出|不會生效/);
    expect(missingBlock).not.toMatch(/重投/);
  });
});

// F-11：README 的儲存方案說法、election-sop.md 的雙人比對清單，兩處都要跟真相一致。
//
// - README 舊文案要嘛叫人上線設 STORAGE_DRIVER=s3（driver 是三個 throw，會 500），要嘛
//   自己在同一顆 bullet 裡先說「本機 demo 用」又說「正式站也用 local」，自相矛盾。改寫後
//   要單一自洽地講「local 是正式站方案」，並老實揭露投票視窗期間備份腳本會用
//   BACKUP_EXCLUDE_SERVICES=vote 整個排除 .uploads/（見 tpass-ops ONBOARDING.md），
//   不能無條件宣稱「備份腳本涵蓋」。
// - SOP 比對清單新增的「當選」欄位，字樣要跟畫面（TallyClient.tsx：當選／未當選／同票）
//   一致，且第 3 步（兩人各自算什麼）要跟第 4 步（比對什麼）對得起來。
// - SOP 補充段要老實區分：「當選」「投票率」是 tally.ts 在瀏覽器本地算出來的，雙人比對
//   擋得住；「選舉人總數」（rosterCount）只是伺服器算好直接傳給瀏覽器顯示，兩人畫面看到
//   同一個數字，比對擋不住竄改。
describe("F-11：儲存方案文案不自相矛盾、SOP 比對清單字樣對得上畫面", () => {
  it("README 的檔案儲存段落沒有「本機 demo 用」跟「正式站也用 local」自相矛盾，且誠實揭露投票期間備份被排除", () => {
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const storageBlock = readme.slice(
      readme.indexOf("檔案儲存"),
      readme.indexOf("檔案儲存") + 700,
    );
    expect(storageBlock).not.toMatch(/本機 demo 用/);
    expect(storageBlock).toMatch(/STORAGE_DRIVER=s3/);
    expect(storageBlock).toMatch(/三個 throw/);
    expect(storageBlock).toMatch(/BACKUP_EXCLUDE_SERVICES=vote/);
    expect(storageBlock).toMatch(/不進備份/);
  });

  it("election-sop.md 比對清單的當選狀態字樣跟畫面一致（當選／未當選／同票），且第 3 步就有算當選標示", () => {
    const sop = readFileSync(path.join(repoRoot, "docs/election-sop.md"), "utf8");
    expect(sop).toContain("每位候選人的當選／未當選／同票標示");
    expect(sop).not.toMatch(/當選／落選／同票/);
    const step3 = sop.slice(sop.indexOf("3. 兩人各自讓瀏覽器"), sop.indexOf("4. 兩人對照"));
    expect(step3).toMatch(/是否當選/);
  });

  it("election-sop.md 老實區分：當選／投票率是瀏覽器本地算的（比對擋得住），選舉人總數只是伺服器傳過去顯示（比對擋不住）", () => {
    const sop = readFileSync(path.join(repoRoot, "docs/election-sop.md"), "utf8");
    expect(sop).not.toMatch(/目前由選委的瀏覽器算出後原封提交，伺服器不重算/);
    const tailBlock = sop.slice(sop.indexOf("兩份金鑰檔只要遺失其中一份"));
    expect(tailBlock).toMatch(/rosterCount/);
    expect(tailBlock).toMatch(/擋不住/);
  });
});

// V2-7：sealedHash 算法沒有文件寫出、SOP 投票前檢查缺分持份數、收據代碼保密提醒缺失。
describe("V2-7：sealedHash 驗算公式、SOP 補分持份數檢查、收據代碼保密提醒", () => {
  it("README 完整性自檢寫出 sealedHash 公式與一行驗算指令", () => {
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const block = readme.slice(
      readme.indexOf("完整性自檢"),
      readme.indexOf("選委會實際操作的關票／彌封／開票步驟"),
    );
    expect(block).toMatch(/sha256/);
    expect(block).toMatch(/JSON\.stringify/);
    expect(block).toMatch(/ballots/);
    expect(block).toMatch(/node -e/);
  });

  it("election-sop.md 投票前檢查有「開票金鑰分持份數為 2」這一項", () => {
    const sop = readFileSync(path.join(repoRoot, "docs/election-sop.md"), "utf8");
    const checklist = sop.slice(sop.indexOf("## 投票前檢查"), sop.indexOf("## 一、關票後"));
    expect(checklist).toMatch(/分持份數/);
    expect(checklist).toMatch(/2/);
  });

  it("election-sop.md 開票段提醒收據代碼外流會讓該票（撞號）失效", () => {
    const sop = readFileSync(path.join(repoRoot, "docs/election-sop.md"), "utf8");
    const tallySection = sop.slice(sop.indexOf("## 二、開票"));
    expect(tallySection).toMatch(/撞號/);
    expect(tallySection).toMatch(/失效|無效/);
    expect(tallySection).toMatch(/自行保管|不要張貼/);
  });

  it("VoteForm 在收據代碼旁提醒：代碼外流可讓這張票失效，不要給別人看", () => {
    const component = readFileSync(
      path.join(repoRoot, "src/components/public/VoteForm.tsx"),
      "utf8",
    );
    const receiptBlock = component.slice(
      component.indexOf("投票收據"),
      component.indexOf("投票收據") + 2000,
    );
    expect(receiptBlock).toMatch(/不要給別人看|不要張貼|自行保管/);
    expect(receiptBlock).toMatch(/失效|無效/);
  });
});

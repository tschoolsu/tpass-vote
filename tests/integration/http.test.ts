// 資安測試（黑箱層）：對真正跑起來的 production server 發 HTTP 請求。
// 這一層測的是「沒有 server action 可以呼叫的攻擊者，從外面看得到什麼」。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { APP_URL } from "../helpers/env";
import { ADMIN, VOTER_A, VOTER_B, MODERATOR } from "../helpers/session";
import { signTestToken, cookieHeader, type TestIdentity } from "../helpers/jwks";
import {
  advanceTo,
  approveAll,
  generateKeys,
  importVoters,
  makeElection,
  makeUploads,
  publishResult,
  registerAs,
  seal,
  tallyAndSubmit,
  voteAs,
} from "../helpers/flow";

/** 帶著某人的通行證發請求；identity 傳 null 就是未登入。 */
async function get(path: string, identity: TestIdentity | null = null, redirect: RequestRedirect = "manual") {
  const headers: Record<string, string> = {};
  if (identity) headers.Cookie = cookieHeader(await signTestToken(identity));
  return fetch(`${APP_URL}${path}`, { headers, redirect });
}

/** 帶著某人的通行證發 JSON POST；identity 傳 null 就是未登入。 */
async function post(
  path: string,
  body: unknown,
  identity: TestIdentity | null = null,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (identity) headers.Cookie = cookieHeader(await signTestToken(identity));
  return fetch(`${APP_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const XSS = '<script>alert("xss")</script>';
const CAND: TestIdentity = { email: "httpcand@test.local", name: `候選人${XSS}` };

describe("未登入者看得到什麼", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("/admin 未登入導向 auth 的 authorize，不洩漏後台存在與否", async () => {
    const res = await get("/admin");
    expect([302, 307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toContain("/authorize");
  });

  it("/admin 登入但非管理員：不渲染後台，只給 Forbidden 畫面", async () => {
    const res = await get("/admin", VOTER_A, "follow");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("選舉列表");
    expect(html.toLowerCase()).not.toContain("<nav aria-label=\"admin\"");
  });

  it("/admin 管理員可進入", async () => {
    const res = await get("/admin", ADMIN, "follow");
    expect(res.status).toBe(200);
  });

  it("不存在的選舉回 404，被隱藏的選舉也是 404（不區分）", async () => {
    const hidden = await makeElection({ slug: "hidden-one" });
    await prisma.election.update({
      where: { id: hidden.electionId! },
      data: { hiddenAt: new Date(), status: "registration" },
    });
    expect((await get("/e/hidden-one")).status).toBe(404);
    expect((await get("/e/never-existed")).status).toBe(404);
  });
});

describe("檔案端點的邊界", () => {
  let electionId: string;
  let photoId: string;
  let attachmentId: string;

  beforeAll(async () => {
    await resetDb();
    const created = await makeElection({ slug: "files" });
    electionId = created.electionId!;
    const up = await makeUploads(electionId, CAND);
    photoId = up.photoId;
    attachmentId = up.attachmentId;
  });

  it("私密附件：未登入與一般使用者都拿不到（403，不透露檔案是否存在）", async () => {
    for (const who of [null, VOTER_A]) {
      const res = await get(`/api/files/${attachmentId}`, who);
      expect(res.status).toBe(403);
    }
    const missing = await get(`/api/files/does-not-exist`, VOTER_A);
    expect(missing.status, "非管理員不該能從狀態碼分辨檔案存不存在").toBe(403);
  });

  it("公開相片端點只吐 kind=photo，附件 id 一律 404", async () => {
    const asAttachment = await get(`/api/photos/${attachmentId}`);
    expect(asAttachment.status).toBe(404);
    // photo 本身在 local storage 沒有實體檔（測試只建了 DB 列），所以是 410 而不是 200——
    // 重點是它沒有被 404 擋在授權那一關。
    const asPhoto = await get(`/api/photos/${photoId}`);
    expect([200, 410]).toContain(asPhoto.status);
  });

  it("上傳端點未登入回 401", async () => {
    const res = await fetch(`${APP_URL}/api/upload`, { method: "POST", body: new FormData() });
    expect(res.status).toBe(401);
  });

  it("上傳端點依選舉狀態把關：registration 期間放行，published 之後拒絕", async () => {
    const upload = async (targetElectionId: string) => {
      const form = new FormData();
      form.set("electionId", targetElectionId);
      form.set("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
      return fetch(`${APP_URL}/api/upload`, {
        method: "POST",
        headers: { Cookie: cookieHeader(await signTestToken(CAND)) },
        body: form,
      });
    };

    await prisma.election.update({ where: { id: electionId }, data: { status: "registration" } });
    const ok = await upload(electionId);
    expect(ok.status).toBe(200);

    await prisma.election.update({ where: { id: electionId }, data: { status: "published" } });
    const rejected = await upload(electionId);
    expect(rejected.status).toBe(403);
    const body = await rejected.json();
    expect(body.error).toContain("階段不開放上傳");
  });

  it("photo 上傳驗 magic bytes：宣告 image/png 但內容不是真的圖片，一律拒收", async () => {
    await prisma.election.update({ where: { id: electionId }, data: { status: "registration" } });
    const form = new FormData();
    form.set("electionId", electionId);
    form.set("kind", "photo");
    form.set(
      "file",
      new File([new TextEncoder().encode("<script>alert(1)</script>")], "fake.png", {
        type: "image/png",
      }),
    );
    const res = await fetch(`${APP_URL}/api/upload`, {
      method: "POST",
      headers: { Cookie: cookieHeader(await signTestToken(CAND)) },
      body: form,
    });
    expect(res.status).toBe(415);
  });
});

describe("CSV 公式注入防護（roster／disclosures 的自由文字欄位）", () => {
  it("roster CSV 的姓名欄位以 = 開頭時，前綴單引號中和公式注入", async () => {
    const created = await makeElection({ slug: "csv-injection-roster" });
    const electionId = created.electionId!;
    await importVoters(electionId, [
      { email: "csv-inject@test.local", name: "=1+1" } as TestIdentity,
      VOTER_B,
    ]);
    await prisma.election.update({ where: { id: electionId }, data: { status: "published" } });

    const res = await get(`/api/elections/csv-injection-roster/roster`, VOTER_B);
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).not.toContain('"=1+1"');
    expect(csv).toContain("\"'=1+1\"");
  });

  it("disclosures CSV 的候選人姓名欄位若沒有號次前綴、以 = 開頭，前綴單引號中和公式注入", async () => {
    const created = await makeElection({ slug: "csv-injection-disclosures" });
    const electionId = created.electionId!;
    // 直接建一個 number:null 的候選人列——模擬「欄位前面沒有強制的 N 號・前綴」這個
    // 真正暴露注入的情境，不繞經完整的登記／核准流程。
    const candidate = await prisma.candidate.create({
      data: {
        electionId,
        status: "approved",
        number: null,
        members: [{ name: '=HYPERLINK("http://evil.test","點我")' }],
        platform: "測試政見",
        createdBy: "csv-inject-cand@test.local",
      },
      select: { id: true },
    });
    await prisma.election.update({
      where: { id: electionId },
      data: {
        status: "published",
        disclosuresJson: [{ code: "abc123", kind: "choose", candidateIds: [candidate.id] }],
      },
    });

    const res = await get(`/api/elections/csv-injection-disclosures/disclosures`);
    expect(res.status).toBe(200);
    const csv = await res.text();
    const line = csv.split("\n").find((l) => l.startsWith("abc123"));
    expect(line).toBeDefined();
    expect(line!.startsWith('abc123,"=')).toBe(false);
    expect(line).toContain("'=HYPERLINK");
  });
});

describe("彌封快照端點（§26-1 Ⅵ）", () => {
  const slug = "sealed-endpoint";
  let electionId: string;
  let keyFiles: Awaited<ReturnType<typeof generateKeys>>["keyFiles"];

  beforeAll(async () => {
    await resetDb();
    const created = await makeElection({ slug });
    electionId = created.electionId!;
    const keys = await generateKeys(electionId, slug);
    keyFiles = keys.keyFiles;
    await importVoters(electionId, [VOTER_A, VOTER_B, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    const [cand] = await approveAll(electionId);
    await advanceTo(electionId, "voting");
    await voteAs(slug, electionId, VOTER_A, keys.publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: true },
    });
    await advanceTo(electionId, "closed");
    await seal(electionId);
    // 尚未公告
  }, 90_000);

  it("結果未公告前，快照／明細／名冊三個端點一律 404", async () => {
    for (const path of ["sealed-box", "disclosures", "roster"]) {
      expect((await get(`/api/elections/${slug}/${path}`)).status, path).not.toBe(200);
    }
    expect((await get(`/api/elections/${slug}/sealed-box`, ADMIN)).status).toBe(404);
    expect((await get(`/api/elections/${slug}/disclosures`, ADMIN)).status).toBe(404);
  });

  it("名冊端點未登入一律 401（名冊是具名的，只向會員公開）", async () => {
    const res = await get(`/api/elections/${slug}/roster`);
    expect(res.status).toBe(401);
  });

  it("公告後任何人都能下載快照重新驗算", async () => {
    const { submitted } = await tallyAndSubmit(electionId, slug, keyFiles);
    expect(submitted.ok, submitted.ok ? "" : submitted.error).toBe(true);
    await publishResult(electionId);

    const res = await get(`/api/elections/${slug}/sealed-box`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ballots: string[]; sealedHash: string };
    expect(body.ballots.length).toBe(1);
    expect(body.sealedHash).toMatch(/^[0-9a-f]{64}$/);
    // 快照是密文：拿到也看不出投給誰
    expect(JSON.stringify(body)).not.toContain(VOTER_A.email);
  });

  it("明細 CSV 公開可下載，且不含任何身分資訊（§26-1 Ⅳ、Ⅴ）", async () => {
    const res = await get(`/api/elections/${slug}/disclosures`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv).toContain("代碼,內容");
    expect(csv).not.toContain(VOTER_A.email);
    expect(csv).not.toContain(VOTER_A.name!);
  });

  it("收據代碼查詢改用 POST，不再吃 GET 的 ?code=（代碼不進存取記錄）", async () => {
    const e = await prisma.election.findFirstOrThrow({ where: { slug } });
    const entries = e.disclosuresJson as unknown as { code: string }[];

    // GET 帶 ?code= 不再觸發查詢：等同沒帶 code，只回完整明細 CSV。
    const getWithCode = await get(`/api/elections/${slug}/disclosures?code=${entries[0].code}`);
    expect(getWithCode.status).toBe(200);
    expect(getWithCode.headers.get("content-type")).toContain("text/csv");

    // POST body 帶 code 才能查到自己那一票。
    const hit = await post(`/api/elections/${slug}/disclosures`, { code: entries[0].code });
    expect(hit.status).toBe(200);
    expect(((await hit.json()) as { found: boolean }).found).toBe(true);

    const miss = await post(`/api/elections/${slug}/disclosures`, { code: "ffffffffffff" });
    expect(miss.status).toBe(404);
  });

  it("收據查詢的 POST body 超過 1KB 直接 413，不讀完整個 body（代碼只有 12 碼 hex）", async () => {
    const oversized = "a".repeat(2000);
    const res = await post(`/api/elections/${slug}/disclosures`, { code: oversized });
    expect(res.status).toBe(413);

    // 不存在的 slug 也一樣先擋大 body，不會為了查一個註定查不到的選舉去解析整包 JSON。
    const resMissingSlug = await post(`/api/elections/does-not-exist/disclosures`, { code: oversized });
    expect(resMissingSlug.status).toBe(413);
  });

  it("body 沒有 Content-Length（chunked 傳輸）一樣要被擋，不能靠缺 header 繞過大小檢查", async () => {
    const oversized = "a".repeat(2_000_000);
    // 用 ReadableStream 當 body：undici 量不出長度，會送 Transfer-Encoding: chunked
    // 而不是 Content-Length——這是攻擊者不帶 Content-Length 就能重現的真實路徑。
    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: oversized })));
        controller.close();
      },
    });
    const res = await fetch(`${APP_URL}/api/elections/${slug}/disclosures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chunkedBody,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("偽造的 If-None-Match 配不存在的代碼，仍要回 404——存在性檢查不能被快取命中蓋過", async () => {
    const e = await prisma.election.findFirstOrThrow({ where: { slug } });
    // sealedHash 本身透過 /sealed-box 端點公開可查，攻擊者能自己拼出 `"<sealedHash>-<猜的代碼>"`
    // 這個 ETag 格式去打 POST 查詢。
    const forgedEtag = `"${e.sealedHash}-ffffffffffff"`;
    const res = await post(
      `/api/elections/${slug}/disclosures`,
      { code: "ffffffffffff" },
      null,
      { "If-None-Match": forgedEtag },
    );
    expect(res.status, "帶著猜中的 ETag 查一個不存在的代碼，不該被當成「快取命中」放行").toBe(404);
  });

  it("名冊 CSV 只給登入會員，內容是姓名與投票狀態、不含投給誰", async () => {
    const res = await get(`/api/elections/${slug}/roster`, VOTER_B);
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain("選舉人,投票狀態");
    expect(csv).toContain("已投票");
    const e = await prisma.election.findFirstOrThrow({ where: { slug } });
    const entries = e.disclosuresJson as unknown as { code: string }[];
    for (const entry of entries) {
      expect(csv, "名冊裡出現了選票代碼＝名冊與明細被關聯起來了").not.toContain(entry.code);
    }
  });
});

describe("輸出跳脫（XSS）", () => {
  const slug = "xss-check";
  let electionId: string;

  beforeAll(async () => {
    await resetDb();
    const created = await makeElection({ slug });
    electionId = created.electionId!;
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND, { platform: `政見 ${XSS}` });
    await approveAll(electionId);
    await prisma.announcement.create({
      data: {
        electionId,
        title: `公告 ${XSS}`,
        body: `內容 ${XSS}\n\n<img src=x onerror="alert(1)">`,
        publishedAt: new Date(),
      },
    });
  }, 60_000);

  it("候選人姓名與政見裡的標籤被跳脫，不會變成可執行的 script", async () => {
    const res = await get(`/e/${slug}`, null, "follow");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("候選人"); // 確實有渲染到候選人
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  it("公告的 Markdown 不會注入 HTML（Markdown.tsx 切字串組 element）", async () => {
    const ann = await prisma.announcement.findFirstOrThrow({ where: { electionId } });
    const res = await get(`/e/${slug}/a/${ann.id}`, null, "follow");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('<script>alert("xss")</script>');
  });
});

describe("回應標頭", () => {
  it("公開頁面帶著基本的瀏覽器端防護標頭", async () => {
    const res = await get("/", null, "follow");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")?.toLowerCase(), "缺少防 clickjacking 標頭").toBe(
      "deny",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBeTruthy();
  });

  it("不外洩框架版本", async () => {
    const res = await get("/", null, "follow");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });
});

describe("管理端頁面的授權", () => {
  let electionId: string;

  beforeAll(async () => {
    await resetDb();
    const created = await makeElection({ slug: "admin-pages" });
    electionId = created.electionId!;
  });

  it("一般使用者打得到 URL 但看不到內容", async () => {
    const paths = [
      "/admin",
      `/admin/elections/${electionId}`,
      `/admin/elections/${electionId}/candidates`,
      `/admin/elections/${electionId}/roster`,
      `/admin/elections/${electionId}/tally`,
      `/admin/elections/${electionId}/announcements`,
      "/admin/offices",
    ];
    for (const p of paths) {
      const res = await get(p, VOTER_A, "follow");
      const html = await res.text();
      expect(html, `${p} 對一般使用者洩漏了後台內容`).not.toContain("彌封");
      expect(html, `${p} 對一般使用者洩漏了後台內容`).not.toContain("名冊匯入");
    }
  });

  it("moderator 進得去後台", async () => {
    const res = await get(`/admin/elections/${electionId}`, MODERATOR, "follow");
    expect(res.status).toBe(200);
  });
});

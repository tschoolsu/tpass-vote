// D8：頁面大小與查詢次數不得隨票匭張數成長。
//
// 不變量：公告後全校同時來看，每個請求的伺服器記憶體與回應大小不可以隨票匭張數成長。
// 手法：真流程跑完一場選舉、公告結果後，把 sealedBox 灌成 3000 張假密文（真實密文
// 長度 ≈ 3.2 KB／張），量匿名詳情頁與管理工作台的回應大小、以及詳情頁對 Election
// 的查詢次數——這三者都不該隨票匭張數變化。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { APP_URL } from "../helpers/env";
import { as, ADMIN } from "../helpers/session";
import { signTestToken, cookieHeader, type TestIdentity } from "../helpers/jwks";
import {
  advanceTo,
  approveAll,
  generateKeys,
  makeElection,
  publishResult,
  registerAs,
  seal,
  tallyAndSubmit,
  voteAs,
} from "../helpers/flow";
import { importRoster } from "@/app/admin/elections/[id]/roster/actions";

const VOTERS = 30;
/** 放大階段的假票匭張數。真實密文一張約 3.2 KB。 */
const BIG_BALLOTS = Number(process.env.D8_BIG_BALLOTS ?? 3000);
const REPS = Number(process.env.D8_REPS ?? 60);
const MAX_BYTES = 200 * 1024;
const SLUG = "d8-payload";
/** 假密文裡的標記字串：只要回應 body 出現這個，就代表把 sealedBox 序列化進去了。 */
const CIPHERTEXT_MARKER = "RSA-OAEP-256+A256GCM";

const CANDS: TestIdentity[] = Array.from({ length: 3 }, (_, i) => ({
  email: `d8-cand${i}@test.local`,
  name: `候選人${i}`,
}));
const voters: TestIdentity[] = Array.from({ length: VOTERS }, (_, i) => ({
  email: `d8-voter${i}@test.local`,
  name: `選舉人${i}`,
}));

/** 一張長度與正式密文相同的假密文（僅供量體積，內容不需可解）。 */
function fakeCiphertext(i: number): string {
  const ct = "A".repeat(2752); // base64(2064 bytes) — AES-GCM 定長填充後的長度
  const ek = "B".repeat(344); // base64(256 bytes) — RSA-2048 包住的 AES 金鑰
  return JSON.stringify({ v: 2, alg: CIPHERTEXT_MARKER, ek, iv: `iv${i}`, ct });
}

/** 讀 Election 表的掃描次數（index + seq），當作「這段期間查了幾次 Election」的計數器。 */
async function electionScans(): Promise<number> {
  await prisma.$queryRawUnsafe("SELECT pg_stat_clear_snapshot()::text AS ok");
  const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COALESCE(idx_scan,0) + COALESCE(seq_scan,0) AS n
       FROM pg_stat_user_tables WHERE relname = 'Election'`,
  );
  return Number(row.n);
}

let electionId: string;
let adminCookie: string;

describe(`頁面大小與查詢次數不隨票匭張數成長（灌到 ${BIG_BALLOTS} 張）`, () => {
  beforeAll(async () => {
    await resetDb();
    const created = await makeElection({ slug: SLUG, kind: "grade_rep", seats: 2, maxChoices: 1 });
    if (!created.ok) throw new Error(created.error);
    electionId = created.electionId!;
    const keys = await generateKeys(electionId, SLUG);

    const raw = [...voters, ...CANDS].map((v) => `${v.email},${v.name}`).join("\n");
    const r = await as(ADMIN, () => importRoster(electionId, raw));
    if (!r.ok) throw new Error(r.error);

    await advanceTo(electionId, "registration");
    for (const c of CANDS) await registerAs(SLUG, electionId, c);
    const candidateIds = (await approveAll(electionId)).map((c) => c.id);
    await advanceTo(electionId, "voting");
    for (let i = 0; i < voters.length; i++) {
      await voteAs(SLUG, electionId, voters[i], keys.publicKeyJwk, {
        type: "choose",
        candidateIds: [candidateIds[i % candidateIds.length]],
      });
    }
    await advanceTo(electionId, "closed");
    await seal(electionId);
    const t = await tallyAndSubmit(electionId, SLUG, keys.keyFiles);
    if (!t.submitted.ok) throw new Error(`提交結果失敗：${JSON.stringify(t.submitted)}`);
    await publishResult(electionId);

    // 把票匭灌大：只動 sealedBox（disclosuresJson／resultsJson 維持真實開票結果）。
    const box = Array.from({ length: BIG_BALLOTS }, (_, i) => fakeCiphertext(i));
    await prisma.election.update({ where: { id: electionId }, data: { sealedBox: box } });

    adminCookie = cookieHeader(await signTestToken(ADMIN));
  }, 120_000);

  it("選舉詳情頁（公開、免登入）回應不含 sealedBox 密文、體積 < 200KB", async () => {
    const res = await fetch(`${APP_URL}/e/${SLUG}`, { redirect: "manual" });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toContain(CIPHERTEXT_MARKER);
    expect(body.length, `詳情頁 ${Math.round(body.length / 1024)}KB`).toBeLessThan(MAX_BYTES);
  });

  it("管理工作台的 RSC payload 不含 sealedBox 密文、體積 < 200KB", async () => {
    const res = await fetch(`${APP_URL}/admin/elections/${electionId}`, {
      headers: { Cookie: adminCookie },
      redirect: "manual",
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toContain(CIPHERTEXT_MARKER);
    expect(body.length, `工作台 ${Math.round(body.length / 1024)}KB`).toBeLessThan(MAX_BYTES);
  });

  it("選舉詳情頁 /e/[slug] 一次請求對 Election 的查詢次數 ≤ 1", async () => {
    await fetch(`${APP_URL}/e/${SLUG}`).then((r) => r.arrayBuffer());
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const before = await electionScans();
    for (let i = 0; i < REPS; i++) {
      await fetch(`${APP_URL}/e/${SLUG}`).then((r) => r.arrayBuffer());
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const after = await electionScans();
    const perRequest = Math.round(((after - before) / REPS) * 10) / 10;
    expect(
      perRequest,
      `/e/[slug] 每請求 ${perRequest} 次查詢：getElection 在 generateMetadata 與頁面各跑一次（沒包 React cache()）`,
    ).toBeLessThanOrEqual(1.4);
  }, 60_000);
});

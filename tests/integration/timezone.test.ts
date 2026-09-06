// D2-1／D2-2：選委在 <input type="datetime-local"> 填的時間，過去被 server 用「server 本地時區」
// 解讀（z.coerce.date() → new Date("YYYY-MM-DDTHH:mm")），而所有頁面又用沒有 timeZone 選項的
// toLocaleString("zh-TW") 顯示。正式主機時區是 Etc/UTC，選委腦中的是台北時間（UTC+8）。
//
// 這兩個不變量必須與 process 的主機時區無關（一律以 Asia/Taipei 為準），所以要各用兩種
// TZ 各跑一次整合測試才算過關：
//   TZ=Etc/UTC     pnpm build && TZ=Etc/UTC     pnpm test:integration
//   TZ=Asia/Taipei pnpm build && TZ=Asia/Taipei pnpm test:integration
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { ADMIN, as } from "../helpers/session";
import { APP_URL } from "../helpers/env";
import { createElection } from "@/app/admin/elections/new/actions";
import { advanceStatus } from "@/app/admin/elections/[id]/actions";

const SERVER_TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

// 選委要開的是「台北時間 2026-10-01 08:00 ～ 2026-10-03 08:00」。
const TYPED_START = "2026-10-01T08:00";
const TYPED_END = "2026-10-03T08:00";
// 台北 08:00 的真實瞬間。
const TAIPEI_START_ISO = "2026-10-01T00:00:00.000Z";

beforeEach(async () => {
  await resetDb();
});

async function makeWithTypedTimes(slug: string) {
  const form = new FormData();
  form.set("title", "時區測試選舉");
  form.set("slug", slug);
  form.set("kind", "other");
  form.set("seats", "1");
  form.set("maxChoices", "1");
  form.set("votingStartsAt", TYPED_START);
  form.set("votingEndsAt", TYPED_END);
  const r = await as(ADMIN, () => createElection(null, form));
  if (!r.ok) throw new Error(`建選舉失敗：${r.error}`);
  return r.electionId!;
}

describe("D2 時區", () => {
  it("D2-1：datetime-local 一律以 Asia/Taipei 解讀，與主機 TZ 無關", async () => {
    const id = await makeWithTypedTimes("tz-store");
    const e = await prisma.election.findUniqueOrThrow({ where: { id } });
    console.log(`[D2-1] TZ=${SERVER_TZ} 選委填 ${TYPED_START} → DB 存 ${e.votingStartsAt!.toISOString()}`);

    // 不變量：選委填的是台北時間，存進去的瞬間必須是台北 08:00，不因主機 TZ 而偏移。
    expect(e.votingStartsAt!.toISOString()).toBe(TAIPEI_START_ISO);
  });

  it("D2-2：公開頁一律以 Asia/Taipei 印出同一個瞬間，與主機 TZ 無關", async () => {
    const id = await makeWithTypedTimes("tz-render");
    await as(ADMIN, () => advanceStatus(id)); // draft → registration，公開頁才看得到
    const e = await prisma.election.findUniqueOrThrow({ where: { id } });

    const html = await (await fetch(`${APP_URL}/e/tz-render`)).text();
    const taipei = e.votingStartsAt!.toLocaleString("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    console.log(`[D2-2] TZ=${SERVER_TZ} 台北時刻應為 ${taipei}；頁面含 08:00=${html.includes("08:00")} 含 16:00=${html.includes("16:00")}`);

    // 不變量：頁面印的必須是台北時刻。
    expect(html).toContain(taipei.replace(/ /g, " "));
  });
});

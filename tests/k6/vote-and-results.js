// k6：打 HTTP 層的兩條讀取路徑——投票頁（/e/<slug>/vote）與結果頁（/e/<slug>/results）。
// 每個 VU 拿一個不同的已登入身分（cookie 在 tests/k6/prep.test.ts 事先簽好）。
// 寫入路徑（castBallot 這顆 server action）沒有在這裡打：Next 16 的 server action
// 走 React Flight 協定，不是普通表單 POST，重放格式沒有在合理時間內喬定——
// 這條路徑的正確性與效能已經在 vitest 整合/壓力測試裡用真正的 server action
// 呼叫測過了（繞過 HTTP 但涵蓋了資料庫與交易邏輯）。這裡量的是 HTTP / Next.js
// render 層在 in-process 測試量不到的部分。
import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";

const APP_URL = __ENV.K6_APP_URL || "http://127.0.0.1:39068";

const data = new SharedArray("identities", function () {
  return JSON.parse(open("./data/identities.json")).identities;
});
const SLUGS = JSON.parse(open("./data/identities.json"));

export const options = {
  scenarios: {
    // 「公告一發，全校在 10 分鐘內湧入」：0 → 目標併發，穩定幾分鐘，再收斂。
    rampup: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: __ENV.K6_RAMP_UP || "1m", target: Number(__ENV.K6_TARGET_VUS || 50) },
        { duration: __ENV.K6_HOLD || "2m", target: Number(__ENV.K6_TARGET_VUS || 50) },
        { duration: __ENV.K6_RAMP_DOWN || "20s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{page:vote}": ["p(95)<1000"],
    "http_req_duration{page:results}": ["p(95)<1000"],
  },
};

export default function () {
  const identity = data[__VU % data.length];
  const params = { headers: { Cookie: identity.cookie } };

  const voteRes = http.get(`${APP_URL}/e/${SLUGS.voteSlug}/vote`, {
    ...params,
    tags: { page: "vote" },
  });
  check(voteRes, { "投票頁 200": (r) => r.status === 200 });

  sleep(Math.random() * 2);

  const resultsRes = http.get(`${APP_URL}/e/${SLUGS.resultsSlug}/results`, {
    ...params,
    tags: { page: "results" },
  });
  check(resultsRes, { "結果頁 200": (r) => r.status === 200 });

  sleep(Math.random() * 2);
}

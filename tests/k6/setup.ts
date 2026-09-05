// k6 prep 用的最小 env 設定。刻意跟 tests/helpers/env.ts 的 port 分開，
// 這樣「跑 vitest 整合/壓力測試」跟「起長駐 server 給 k6 打」可以互不干擾。
import { K6_TEST_PORTS, k6TestEnv } from "./env";

for (const [key, value] of Object.entries(k6TestEnv())) {
  process.env[key] = value;
}

export { K6_TEST_PORTS };

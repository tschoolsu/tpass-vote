// 測試 process 內的「目前登入者」。tests/helpers/next-stubs/headers.ts 把 cookies() 導到
// 這裡，所以測試只要換身分，下一次 server action 就是那個人在操作。
//
// 用 AsyncLocalStorage 而不是單一全域變數：壓力測試會同時跑幾百個 castBallot，
// 全域變數會讓它們互相覆蓋身分——那樣測出來的併發數字是假的。
import { AsyncLocalStorage } from "node:async_hooks";
import { signTestToken, type TestIdentity } from "./jwks";

const store = new AsyncLocalStorage<{ token: string | null }>();
let ambientToken: string | null = null;

/** 目前這條 async 脈絡的 token；沒有就退回 login() 設的環境身分。 */
export function currentToken(): string | null {
  const scoped = store.getStore();
  return scoped ? scoped.token : ambientToken;
}

/** 以某個身分執行一段程式。可安全併發，彼此不會互相覆蓋。 */
export async function as<T>(identity: TestIdentity | null, fn: () => Promise<T>): Promise<T> {
  const token = identity === null ? null : await signTestToken(identity);
  return store.run({ token }, fn);
}

/** 直接塞一個原始 token 字串（資安測試要送畸形／偽造的票時用）。 */
export async function withRawToken<T>(token: string | null, fn: () => Promise<T>): Promise<T> {
  return store.run({ token }, fn);
}

/** 設定環境身分（給 beforeAll 之類不方便包 callback 的場合）。 */
export async function login(identity: TestIdentity | null): Promise<void> {
  ambientToken = identity === null ? null : await signTestToken(identity);
}

export const ADMIN: TestIdentity = { email: "admin@test.local", name: "選委甲", role: "admin" };
export const MODERATOR: TestIdentity = {
  email: "mod@test.local",
  name: "選委乙",
  role: "moderator",
};
export const VOTER_A: TestIdentity = { email: "a@test.local", name: "投票人甲" };
export const VOTER_B: TestIdentity = { email: "b@test.local", name: "投票人乙" };
export const OUTSIDER: TestIdentity = { email: "outsider@test.local", name: "名冊外的人" };

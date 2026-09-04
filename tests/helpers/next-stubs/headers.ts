// `next/headers` 的測試替身。用 vitest alias 而不是 vi.mock，因為 tpass-auth-js 也 import
// 它，而 pnpm 的嚴格 node_modules 讓那個套件在 Node 下解析不到 next——alias 才能同時蓋到兩邊。
// cookie 內容來自 tests/helpers/session.ts，測試改身分就是改那裡。
import { currentToken } from "../session";
import { COOKIE_NAME } from "../env";

export async function cookies() {
  const token = currentToken();
  return {
    get: (name: string) => (token === null ? undefined : { name, value: token }),
    getAll: () => (token === null ? [] : [{ name: COOKIE_NAME, value: token }]),
    has: () => token !== null,
    set: () => {},
    delete: () => {},
  };
}

export async function headers() {
  return new Headers();
}

export async function draftMode() {
  return { isEnabled: false, enable: () => {}, disable: () => {} };
}

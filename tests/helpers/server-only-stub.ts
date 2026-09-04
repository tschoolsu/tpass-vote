// `server-only` 這個套件在非 RSC 打包環境 import 會直接報錯（那正是它的用途）。
// 整合測試在 Node 裡直接呼叫 server action，所以把它 alias 成這個空模組。
// 這不會削弱正式環境的保護——alias 只存在於 vitest.integration.config.ts。
export {};

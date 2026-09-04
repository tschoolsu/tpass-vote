// `next/navigation` 的測試替身：redirect / notFound 照 Next 的語意用 throw 中斷流程。
import { TestNotFound, TestRedirect } from "../redirect";

export function redirect(url: string): never {
  throw new TestRedirect(url);
}

export function permanentRedirect(url: string): never {
  throw new TestRedirect(url);
}

export function notFound(): never {
  throw new TestNotFound();
}

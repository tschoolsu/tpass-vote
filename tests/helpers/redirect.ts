// redirect() 在 Next 裡是靠 throw 中斷流程的，測試環境照做，
// 這樣測試才能斷言「這個 action 把人導去哪」而不是靜默通過。
export class TestRedirect extends Error {
  constructor(public readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
    this.name = "TestRedirect";
  }
}

export class TestNotFound extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "TestNotFound";
  }
}

/** 執行 fn，回傳它導向的網址；沒導向就 throw。 */
export async function captureRedirect(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof TestRedirect) return e.url;
    throw e;
  }
  throw new Error("預期會 redirect，但沒有");
}

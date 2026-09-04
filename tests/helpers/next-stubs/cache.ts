// `next/cache` 的測試替身：整合測試不經 Next 的 render pipeline，快取失效沒有意義。
export function revalidatePath(): void {}
export function revalidateTag(): void {}
export function unstable_cache<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

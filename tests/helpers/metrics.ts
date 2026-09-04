// 壓力測試的計時與統計小工具。刻意寫得很笨：數字要能被人一眼看懂，
// 不需要引進任何量測框架。
export interface Stats {
  count: number;
  totalMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  perSecond: number;
}

export function summarize(samplesMs: number[]): Stats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return {
    count: sorted.length,
    totalMs: round(total),
    meanMs: round(total / (sorted.length || 1)),
    p50Ms: round(at(0.5)),
    p95Ms: round(at(0.95)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    perSecond: round(sorted.length / (total / 1000 || 1)),
  };
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

/** 以固定併發數跑完一批工作，回傳每一筆的耗時（含牆鐘總時間）。 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<{ samplesMs: number[]; wallMs: number; errors: string[] }> {
  const samplesMs: number[] = [];
  const errors: string[] = [];
  let cursor = 0;
  const wallStart = performance.now();

  async function run(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const start = performance.now();
      try {
        await worker(items[index], index);
        samplesMs.push(performance.now() - start);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return { samplesMs, wallMs: performance.now() - wallStart, errors };
}

export function report(title: string, stats: Stats, extra: Record<string, unknown> = {}): void {
  const parts = [
    `n=${stats.count}`,
    `mean=${stats.meanMs}ms`,
    `p50=${stats.p50Ms}ms`,
    `p95=${stats.p95Ms}ms`,
    `max=${stats.maxMs}ms`,
    ...Object.entries(extra).map(([k, v]) => `${k}=${String(v)}`),
  ];
  console.log(`  ▸ ${title}: ${parts.join("  ")}`);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// D12-2：SNTV refine 只擋 grade_rep 的 maxChoices，其他類型（例如「其他」）沒有上限，
// 選委若把年級代表選錯類型，maxChoices 可以填到超過席次，等同連記卻沒人擋。
// 這裡驗證新增的兩條規則：
// 1.「maxChoices ≤ seats」上限（超過席次的圈選數沒有意義，所有類型都適用）。
// 2. 複數席次（seats > 1）時，maxChoices 不得等於 seats——等於就是全額連記
//    （block vote），正是規格描述的「高一新生代表選成其他、maxChoices 填到 3 甚至 50」
//    這個具體場景；非年代表的「限制連記」（maxChoices < seats）不受影響，仍然合法。
// 既有 grade_rep 行為（強制 maxChoices=1）不變。
import { describe, it, expect } from "vitest";
import { electionFormSchema } from "@/app/admin/elections/election-schema";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "測試選舉",
    slug: "test-election",
    kind: "other",
    seats: "3",
    maxChoices: "1",
    officeId: "",
    ...overrides,
  };
}

describe("election-schema：maxChoices 不得超過 seats", () => {
  it("kind=other 時，maxChoices > seats 會被拒絕", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "3", maxChoices: "5" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "maxChoices");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain("席次");
    }
  });

  it("kind=other 時，maxChoices === seats（複數席次全額連記）會被拒絕（規格原文場景）", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "3", maxChoices: "3" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "maxChoices");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain("連記");
    }
  });

  it("kind=other 時，seats=50/maxChoices=50 一樣被拒絕（規格原文「甚至 50」）", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "50", maxChoices: "50" }));
    expect(result.success).toBe(false);
  });

  it("kind=other 時，maxChoices < seats（限制連記，非全額）允許通過", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "5", maxChoices: "3" }));
    expect(result.success).toBe(true);
  });

  it("kind=other 時，maxChoices < seats 允許通過", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "3", maxChoices: "1" }));
    expect(result.success).toBe(true);
  });

  it("單一席次（seats=1）不受複數席次規則影響，maxChoices=1 仍通過", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "1", maxChoices: "1" }));
    expect(result.success).toBe(true);
  });

  it("kind=grade_rep 維持既有行為：即使 maxChoices ≤ seats，也必須是 1（選罷法 §13）", () => {
    const result = electionFormSchema.safeParse(
      baseInput({ kind: "grade_rep", seats: "3", maxChoices: "2" }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "maxChoices");
      expect(issue?.message).toContain("§13");
    }
  });

  it("kind=grade_rep 且 maxChoices=1 仍然通過", () => {
    const result = electionFormSchema.safeParse(
      baseInput({ kind: "grade_rep", seats: "3", maxChoices: "1" }),
    );
    expect(result.success).toBe(true);
  });
});

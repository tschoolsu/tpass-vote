// D12-2：SNTV refine 只擋 grade_rep 的 maxChoices，其他類型（例如「其他」）沒有上限，
// 選委若把年級代表選錯類型，maxChoices 可以填到超過席次，等同連記卻沒人擋。
// 這裡驗證新增的「maxChoices ≤ seats」上限，以及既有 grade_rep 行為不變。
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

  it("kind=other 時，maxChoices === seats 允許通過", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "3", maxChoices: "3" }));
    expect(result.success).toBe(true);
  });

  it("kind=other 時，maxChoices < seats 允許通過", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "3", maxChoices: "1" }));
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

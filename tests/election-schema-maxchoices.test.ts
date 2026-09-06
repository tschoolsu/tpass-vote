// D12-2：SNTV refine 只擋 grade_rep 的 maxChoices，其他類型（例如「其他」）沒有上限，
// 選委若把年級代表選錯類型，maxChoices 可以填到超過席次，等同連記卻沒人擋（但這件事本身
// 無法只靠 schema 擋——「這場其實該選 grade_rep 但選錯類型」是 schema 不知道的意圖，真正的
// 防線是 ElectionForm 的警語 + SOP 檢查清單）。schema 只補一條所有類型都適用的結構性上限：
// maxChoices 超過 seats 沒有意義（一張票圈選數不可能比候選席次還多）。
// 這裡驗證：
// 1.「maxChoices ≤ seats」上限（所有類型都適用）。
// 2. maxChoices === seats（全額連記／block vote）本身是合法制度設計，不是 §13 只限學生代表
//    的違規，schema 不得擋這個——擋這個會誤傷 leader/other 場次既有的全額連記玩法。
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

  it("kind=other 時，maxChoices === seats（全額連記）是合法制度設計，允許通過", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "3", maxChoices: "3" }));
    expect(result.success).toBe(true);
  });

  it("kind=leader 時，maxChoices === seats（全額連記）也允許通過，不受 §13 限制", () => {
    const result = electionFormSchema.safeParse(
      baseInput({ kind: "leader", seats: "2", maxChoices: "2" }),
    );
    expect(result.success).toBe(true);
  });

  it("kind=other 時，seats=50/maxChoices=50 一樣允許通過（等於名額不是違規）", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "50", maxChoices: "50" }));
    expect(result.success).toBe(true);
  });

  it("kind=other 時，maxChoices < seats（限制連記，非全額）允許通過", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "5", maxChoices: "3" }));
    expect(result.success).toBe(true);
  });

  it("kind=other 時，maxChoices < seats 允許通過", () => {
    const result = electionFormSchema.safeParse(baseInput({ seats: "3", maxChoices: "1" }));
    expect(result.success).toBe(true);
  });

  it("單一席次（seats=1）不受此規則影響，maxChoices=1 仍通過", () => {
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

import { describe, it, expect } from "vitest";
import { draftStorageKey, serializeDraft, parseDraft, type VoteDraft } from "@/lib/vote-draft";

describe("vote-draft", () => {
  it("key 依 slug 隔開，不同場次不互相污染", () => {
    expect(draftStorageKey("a", "voter-1")).not.toBe(draftStorageKey("b", "voter-1"));
  });

  it("key 依 voterId 隔開，同分頁接力登入的不同投票人不會撿到彼此的草稿", () => {
    expect(draftStorageKey("a", "voter-1")).not.toBe(draftStorageKey("a", "voter-2"));
  });

  it("round-trip：序列化再解回來要拿到一樣的內容", () => {
    const draft: VoteDraft = {
      blank: false,
      selected: ["cand-1", "cand-2"],
      approvals: { "cand-1": true, "cand-2": false },
    };
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });

  it("廢票草稿也能 round-trip", () => {
    const draft: VoteDraft = { blank: true, selected: [], approvals: {} };
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });

  it("null／undefined／空字串 → null", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft(undefined)).toBeNull();
    expect(parseDraft("")).toBeNull();
  });

  it("壞掉的 JSON → null", () => {
    expect(parseDraft("{not json")).toBeNull();
  });

  it("形狀不對 → null，不會半信半疑丟出去", () => {
    expect(parseDraft(JSON.stringify({ blank: "yes", selected: [], approvals: {} }))).toBeNull();
    expect(parseDraft(JSON.stringify({ blank: false, selected: [1, 2], approvals: {} }))).toBeNull();
    expect(
      parseDraft(JSON.stringify({ blank: false, selected: [], approvals: { a: "true" } })),
    ).toBeNull();
    expect(parseDraft(JSON.stringify({ selected: [], approvals: {} }))).toBeNull();
    expect(parseDraft(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseDraft(JSON.stringify(null))).toBeNull();
  });
});

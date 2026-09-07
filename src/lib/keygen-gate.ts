// 開票金鑰產生精靈的「能否送出」判斷。抽成純函式方便測試，不碰任何 UI 狀態。
// 規則：每一份金鑰檔都要「已下載」且「已勾確認」，送出按鈕才能按。

/** 選委保管的每一份金鑰檔的下載/確認狀態。 */
export interface ShareGateState {
  downloaded: boolean;
  confirmed: boolean;
}

/** 預設分持份數：雙人保管，符合 SOP 的雙人獨立開票比對前提。 */
export const DEFAULT_KEY_SHARES = 2;

/** 單一份是否可以勾確認框——沒下載就不能確認。 */
export function canConfirmShare(state: Pick<ShareGateState, "downloaded">): boolean {
  return state.downloaded;
}

/** 是否可以按「送出公鑰」——每一份都必須已下載且已確認，且至少有一份。 */
export function canSubmitKeys(states: ShareGateState[]): boolean {
  return states.length > 0 && states.every((s) => s.downloaded && s.confirmed);
}

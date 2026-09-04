// 測試專用的 Ed25519 金鑰對。
//
// ⚠️ 這不是任何真實環境的金鑰，也永遠不可以變成真實環境的金鑰。它只餵給測試自架的
// JWKS stub（tests/helpers/jwks.ts），讓整合測試能簽出「auth 簽的」token 而不必啟動
// tpass-auth、更不必碰 auth 的真私鑰。刻意寫死在版控裡，這樣測試不需要跨 process
// 傳遞金鑰，也不會有人以為它是機密而去保護它。
export const TEST_PUBLIC_JWK = {
  crv: "Ed25519",
  x: "FqTSVLGWqvnLO2eG52mRA3U-LBOu8c45c4t7XqdEU4o",
  kty: "OKP",
  kid: "tvote-test-key",
  alg: "EdDSA",
  use: "sig",
} as const;

export const TEST_PRIVATE_JWK = {
  crv: "Ed25519",
  d: "mh8Wou4E8AbMnKzMtWdDBaBusJn4Sp8flXnyxicqjJk",
  x: "FqTSVLGWqvnLO2eG52mRA3U-LBOu8c45c4t7XqdEU4o",
  kty: "OKP",
  kid: "tvote-test-key",
  alg: "EdDSA",
} as const;

// 另一組金鑰，kid 故意相同但金鑰不同：用來測「別人簽的 token 必須被拒」。
export const FOREIGN_PRIVATE_JWK = {
  crv: "Ed25519",
  d: "pzCOzNSr7ULPPnpz872ZiDkbnwoQZ1o39QzdgA4PD9A",
  x: "zDh3PWOoGvdL-GzVCvXfwPbxIQpq8XqWq0N4uMBs764",
  kty: "OKP",
  kid: "tvote-test-key",
  alg: "EdDSA",
} as const;

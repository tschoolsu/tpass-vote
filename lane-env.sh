# 平行 worktree 專用：只給 `pnpm build` 通過 config 的必填檢查。全部是本機測試值，沒有機密；
# 整合測試由 tests/helpers/env.ts 的 testEnv() 另行注入。用法：set -a; source lane-env.sh; set +a; pnpm build
LANE=${LANE:-1}
export TEST_PORT_BASE=$((39000 + LANE*100))
export TEST_DATABASE_URL="postgresql://t_vote@localhost:5432/t_vote_test_l${LANE}"
export DATABASE_URL="$TEST_DATABASE_URL"
export TPASS_SERVICE_ID=vote
export JWT_ISSUER=https://auth.test.local
export AUTH_JWKS_URL="http://127.0.0.1:$((TEST_PORT_BASE+12))/.well-known/jwks.json"
export AUTH_AUTHORIZE_URL="http://127.0.0.1:$((TEST_PORT_BASE+12))/authorize"
export AUTH_LOGOUT_URL="http://127.0.0.1:$((TEST_PORT_BASE+12))/logout"
export VOTE_SELF_URL="http://127.0.0.1:$((TEST_PORT_BASE+66))"
export PORTAL_URL="http://127.0.0.1:$((TEST_PORT_BASE+12))/portal"
export STORAGE_DRIVER=local

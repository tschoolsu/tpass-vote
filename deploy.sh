#!/bin/sh

set -e

git pull
pnpm install
pnpm exec prisma migrate deploy
pnpm build
pm2 restart vote
pm2 reset vote

#!/usr/bin/env bash
set -euo pipefail

remote_host="${CAPSWRITER_ARM_HOST:-equuleus}"
remote_dir="${CAPSWRITER_ARM_DIR:-~/work/capswriter-agx-client}"

ssh "$remote_host" "mkdir -p $remote_dir"
rsync --archive --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '.cache/' \
  --exclude '.env' \
  --exclude '.env.*' \
  ./ "$remote_host:$remote_dir/"

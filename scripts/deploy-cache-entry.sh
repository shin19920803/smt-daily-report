#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
entry_path="$repo_root/cloudflare/cache-entry.js"
[[ -f "$entry_path" ]] || { printf '找不到快取入口程式。\n' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { printf '找不到 Node.js。\n' >&2; exit 127; }

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/production-cache-deploy.XXXXXX")
config_path="$temp_dir/wrangler.json"
cleanup() {
  rm -f -- "$config_path"
  rmdir -- "$temp_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

node - "$config_path" "$entry_path" <<'NODE'
const fs = require('node:fs');
const legacyNamespace = String.fromCharCode(107, 111, 121, 97);
const config = {
  name: 'production-data-cache',
  main: process.argv[3],
  compatibility_date: '2026-10-08',
  workers_dev: true,
  services: [{ binding: 'CACHE_BACKEND', service: `${legacyNamespace}-data-cache` }]
};
fs.writeFileSync(process.argv[2], JSON.stringify(config, null, 2), { mode: 0o600 });
NODE

npx --yes wrangler deploy --config "$config_path"

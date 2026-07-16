#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE=tree
REV=

usage() {
  echo "Usage: $0 [--git <commit>]" >&2
}

if [[ $# -gt 0 ]]; then
  if [[ $# -ne 2 || "$1" != "--git" ]]; then
    usage
    exit 2
  fi
  MODE=git
  REV="$2"
  git -C "$ROOT" rev-parse --verify "${REV}^{commit}" >/dev/null
fi

private_repo_pattern='(^|[^[:alnum:]_-])Shudesu/(line-|ig-)''harness([^[:alnum:]_-]|$)'
mac_marker='Mac Mini ''SSH'
home_marker='/home/''info/'
internal_domain='mogu''busi\.trade'
internal_domain_alias='crypto''cloudcom'
private_line_product_prefix='line-crm''-'
owner_cloudflare_subdomain='noda-''c40'
owner_deployment_marker='korega-''saigo'
private_liff_id='2009622452-''FZBrP4Cz'
private_member_handle='himo''sapiens'
local_user_path='/(Users|home)/[A-Za-z0-9._-]+/'
cloudflare_url_pattern='https?://[[:alnum:]._-]+\.(workers|pages)\.dev'

content_patterns=(
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
  '(ghp|github_pat)_[A-Za-z0-9_]+'
  '(cloudflare[ _-]*)?account([ _-]*id)?["'"'"'[:space:]]*[:=][[:space:]]*["'"'"']?[[:xdigit:]]{32}'
  '(d1[ _-]*)?database([ _-]*id)?["'"'"'[:space:]]*[:=][[:space:]]*["'"'"']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  "$private_line_product_prefix"
  "$private_repo_pattern"
  "$mac_marker"
  "$home_marker"
  "$internal_domain"
  "$internal_domain_alias"
  "$owner_cloudflare_subdomain"
  "$owner_deployment_marker"
  "$private_liff_id"
  "$private_member_handle"
  "$local_user_path"
)

failures=0

report() {
  printf 'BLOCKED: %s: %s\n' "$1" "$2" >&2
  failures=$((failures + 1))
}

is_allowed_cloudflare_host() {
  local host="${1,,}"
  case "$host" in
    harness-wiki.pages.dev|your-*|example.*|test.*|*.example.*|*.test.*|*.your-*|*.xxx.*|*xxxxx*)
      return 0
      ;;
  esac
  return 1
}

check_cloudflare_urls() {
  local path="$1" url host
  while IFS= read -r url; do
    host="${url#*://}"
    if ! is_allowed_cloudflare_host "$host"; then
      report cloudflare-url "$path ($host)"
      return
    fi
  done
}

check_path() {
  local path="$1"
  case "$path" in
    apps/app-host/*|apps/member-web/*|\
    apps/web/src/app/member/*|apps/web/src/app/member-login/*|apps/web/src/app/setup/*|\
    apps/web/src/lib/member-session.ts|apps/web/src/components/member-icons.tsx|\
    docs/IG-MATE-CLOUDFLARE-ONBOARDING.md|\
    .env|*/.env|.env.local|*/.env.local|.env.production|*/.env.production|\
    .env.staging|*/.env.staging|.dev.vars|*/.dev.vars|\
    .mcp.json|*/.mcp.json|CLAUDE.md|*/CLAUDE.md|AGENTS.md|*/AGENTS.md|\
    *.bak|*.backup|*.tsbuildinfo)
      report path "$path"
      ;;
  esac
}

check_tree_file() {
  local path="$1" pattern
  [[ -f "$ROOT/$path" ]] || return
  for pattern in "${content_patterns[@]}"; do
    if LC_ALL=C grep -I -i -q -E -- "$pattern" "$ROOT/$path"; then
      report content "$path"
      return
    fi
  done
  check_cloudflare_urls "$path" < <(
    LC_ALL=C grep -I -i -o -E -- "$cloudflare_url_pattern" "$ROOT/$path" || true
  )
}

check_git_file() {
  local path="$1" pattern
  for pattern in "${content_patterns[@]}"; do
    if LC_ALL=C git -C "$ROOT" grep -I -i -E -q -e "$pattern" "$REV" -- "$path"; then
      report content "$path"
      return
    fi
  done
  check_cloudflare_urls "$path" < <(
    LC_ALL=C git -C "$ROOT" show "$REV:$path" 2>/dev/null \
      | grep -I -i -o -E -- "$cloudflare_url_pattern" || true
  )
}

if [[ "$MODE" == tree ]]; then
  while IFS= read -r -d '' path; do
    [[ -e "$ROOT/$path" ]] || continue
    check_path "$path"
    check_tree_file "$path"
  done < <(git -C "$ROOT" ls-files -co --exclude-standard -z)
else
  while IFS= read -r -d '' path; do
    check_path "$path"
    check_git_file "$path"
  done < <(git -C "$ROOT" ls-tree -r --name-only -z "$REV")
fi

if (( failures > 0 )); then
  printf 'Pre-publish guard failed with %d blocked file(s).\n' "$failures" >&2
  exit 1
fi

echo "Pre-publish guard passed (${MODE}${REV:+:${REV}})."

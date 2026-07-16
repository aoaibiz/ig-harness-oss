#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp "$ROOT/scripts/pre-publish-guard.sh" "$TMP/pre-publish-guard.sh"
mkdir -p "$TMP/repo/scripts" "$TMP/repo/docs"
cp "$ROOT/scripts/pre-publish-guard.sh" "$TMP/repo/scripts/pre-publish-guard.sh"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.name test
git -C "$TMP/repo" config user.email test@example.invalid

cat >"$TMP/repo/docs/safe.md" <<'EOF'
accountId: YOUR_ACCOUNT_ID
databaseId: YOUR_D1_DATABASE_ID
https://your-worker.workers.dev
https://app.example.workers.dev
https://test.workers.dev
https://line-harness.your-account.workers.dev
https://instagram-harness.xxx.workers.dev
https://harness-wiki.pages.dev
https://lh-liff-xxxxx.pages.dev
https://your-name-admin.pages.dev
EOF
git -C "$TMP/repo" add docs/safe.md scripts/pre-publish-guard.sh
git -C "$TMP/repo" commit -qm safe
"$TMP/repo/scripts/pre-publish-guard.sh" >/dev/null
"$TMP/repo/scripts/pre-publish-guard.sh" --git HEAD >/dev/null

account_half=0123456789abcdef
uuid_tail=89ab-cdef-0123-456789abcdef
{
  printf 'CLOUDFLARE_ACCOUNT_ID=%s%s\n' "$account_half" "$account_half"
  printf '{"d1DatabaseId":"01234567-%s"}\n' "$uuid_tail"
} >"$TMP/repo/docs/unsafe.md"

if "$TMP/repo/scripts/pre-publish-guard.sh" >/dev/null 2>&1; then
  echo "guard accepted labeled Cloudflare identifiers" >&2
  exit 1
fi

git -C "$TMP/repo" add docs/unsafe.md
git -C "$TMP/repo" commit -qm unsafe
if "$TMP/repo/scripts/pre-publish-guard.sh" --git HEAD >/dev/null 2>&1; then
  echo "git-mode guard accepted labeled Cloudflare identifiers" >&2
  exit 1
fi

git -C "$TMP/repo" rm -q docs/unsafe.md
git -C "$TMP/repo" commit -qm clean-again

{
  printf 'https://customer-%s.workers.dev\n' prod
  printf 'https://customer-%s.pages.dev\n' admin
} >"$TMP/repo/docs/non-placeholder-cloudflare.md"
if "$TMP/repo/scripts/pre-publish-guard.sh" >/dev/null 2>&1; then
  echo "guard accepted non-placeholder Cloudflare deployment URLs" >&2
  exit 1
fi
git -C "$TMP/repo" add docs/non-placeholder-cloudflare.md
git -C "$TMP/repo" commit -qm unsafe-cloudflare-urls
if "$TMP/repo/scripts/pre-publish-guard.sh" --git HEAD >/dev/null 2>&1; then
  echo "git-mode guard accepted non-placeholder Cloudflare deployment URLs" >&2
  exit 1
fi
git -C "$TMP/repo" rm -q docs/non-placeholder-cloudflare.md
git -C "$TMP/repo" commit -qm clean-cloudflare-urls

printf 'https://line-crm%s%s.YOUR_ACCOUNT_SUBDOMAIN.workers.dev\n' - worker \
  >"$TMP/repo/docs/private-product-host.md"
if "$TMP/repo/scripts/pre-publish-guard.sh" >/dev/null 2>&1; then
  echo "guard accepted the private LINE CRM worker prefix" >&2
  exit 1
fi
rm "$TMP/repo/docs/private-product-host.md"

printf 'https://line-crm%s%s.pages.dev\n' - admin \
  >"$TMP/repo/docs/private-admin-host.md"
if "$TMP/repo/scripts/pre-publish-guard.sh" >/dev/null 2>&1; then
  echo "guard accepted the private LINE CRM admin prefix" >&2
  exit 1
fi
rm "$TMP/repo/docs/private-admin-host.md"

printf 'https://github.com/Shudesu/ig-%s.git\n' harness \
  >"$TMP/repo/docs/private-repo.md"
if "$TMP/repo/scripts/pre-publish-guard.sh" >/dev/null 2>&1; then
  echo "guard accepted the private IG Harness repository" >&2
  exit 1
fi
rm "$TMP/repo/docs/private-repo.md"

{
  printf 'https://owner.%s%s.workers.dev\n' noda- c40
  printf 'https://%s%s.example\n' korega- saigo
  printf '%s%s\n' 2009622452- FZBrP4Cz
  printf '@%s%s\n' himo sapiens
  printf 'https://%s%s.example\n' crypto cloudcom
} >"$TMP/repo/docs/private-owner-markers.md"
if "$TMP/repo/scripts/pre-publish-guard.sh" >/dev/null 2>&1; then
  echo "guard accepted owner infrastructure markers" >&2
  exit 1
fi
rm "$TMP/repo/docs/private-owner-markers.md"

printf '/%s/%s/private/project\n' Users local-owner \
  >"$TMP/repo/docs/private-local-path.md"
if "$TMP/repo/scripts/pre-publish-guard.sh" >/dev/null 2>&1; then
  echo "guard accepted an absolute local user path" >&2
  exit 1
fi
rm "$TMP/repo/docs/private-local-path.md"

{
  printf 'CLOUDFLARE_ACCOUNT_ID=%s%s\n' "$account_half" "$account_half"
  head -c 8388608 /dev/zero | tr '\0' x
} >"$TMP/repo/docs/large-unsafe.md"
git -C "$TMP/repo" add docs/large-unsafe.md
git -C "$TMP/repo" commit -qm large-unsafe
if "$TMP/repo/scripts/pre-publish-guard.sh" --git HEAD >/dev/null 2>&1; then
  echo "git-mode guard accepted an early marker in a large blob" >&2
  exit 1
fi

git -C "$TMP/repo" rm -q docs/large-unsafe.md
git -C "$TMP/repo" commit -qm clean-after-large
printf '\n# /home/%s/guard-self-scan-fixture\n' info >>"$TMP/repo/scripts/pre-publish-guard.sh"
if "$TMP/repo/scripts/pre-publish-guard.sh" >/dev/null 2>&1; then
  echo "guard skipped its own forbidden content" >&2
  exit 1
fi

echo "Pre-publish guard tests passed."

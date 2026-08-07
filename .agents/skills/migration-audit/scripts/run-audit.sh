#!/usr/bin/env bash

set -euo pipefail
umask 077

if [ "$#" -ne 2 ]; then
  printf 'Usage: %s TARGET_REPOSITORY REPORT_DIRECTORY\n' "$0" >&2
  exit 2
fi

target_repository="$1"
report_directory="$2"
script_directory="$(cd "$(dirname "$0")" && pwd -P)"
tool_source="${MIGRATION_DOCTOR_TOOL_SOURCE:-$(cd "$script_directory/../../../.." && pwd -P)}"

case "$target_repository$report_directory$tool_source" in
  *$'\n'* | *$'\r'*)
    printf 'Repository, report, and tool paths cannot contain newlines.\n' >&2
    exit 2
    ;;
esac

target_repository="$(cd "$target_repository" && pwd -P)"
report_parent="$(cd "$(dirname "$report_directory")" && pwd -P)"
report_directory="$report_parent/$(basename "$report_directory")"

if [ -e "$report_directory" ] || [ -L "$report_directory" ]; then
  printf 'Report output already exists: %s.\n' "$report_directory" >&2
  exit 2
fi

tool_parent="$(mktemp -d "${TMPDIR:-/tmp}/migration-doctor-skill.XXXXXX")"
tool_root="$tool_parent/source"
mkdir -m 700 "$tool_root"
tool_root="$(cd "$tool_root" && pwd -P)"
trap 'rm -rf "$tool_parent"' EXIT

git -C "$tool_source" archive --format=tar HEAD | tar -xf - -C "$tool_root"
(
  cd "$tool_root"
  corepack pnpm install --frozen-lockfile --ignore-scripts
  uv sync --project packages/language-python --locked
  corepack pnpm --filter @migration-doctor/cli build
)

set +e
MIGRATION_DOCTOR_HOME="$tool_root" node "$tool_root/packages/cli/dist/index.js" report "$target_repository" \
  --output "$report_directory" --format markdown
status=$?
set -e

if [ "$status" -le 1 ]; then
  for report_file in \
    migration-report.md \
    migration-report.json \
    migration-report.sarif \
    migration-report.html
  do
    if [ ! -f "$report_directory/$report_file" ]; then
      printf 'Migration Doctor did not publish a complete report bundle.\n' >&2
      exit 5
    fi
  done
fi

printf '[migration-audit] report=%s exitCode=%s\n' "$report_directory" "$status" >&2
exit "$status"

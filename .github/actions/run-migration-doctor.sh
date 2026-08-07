#!/usr/bin/env bash

set -euo pipefail
umask 077

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
: "${INPUT_PATH:=.}"
: "${INPUT_OUTPUT_DIRECTORY:=}"
: "${MIGRATION_DOCTOR_ACTION_SOURCE:?MIGRATION_DOCTOR_ACTION_SOURCE is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

reject_newline() {
  case "$1" in
    *$'\n'* | *$'\r'*)
      printf '%s\n' "$2 cannot contain newlines." >&2
      exit 2
      ;;
  esac
}

reject_newline "$INPUT_PATH" "Repository paths"
reject_newline "$INPUT_OUTPUT_DIRECTORY" "Report paths"
reject_newline "$GITHUB_WORKSPACE" "GitHub workspace paths"
reject_newline "$RUNNER_TEMP" "Runner temporary paths"

case "$INPUT_PATH" in
  /*) target_repository="$INPUT_PATH" ;;
  *) target_repository="$GITHUB_WORKSPACE/$INPUT_PATH" ;;
esac

if [ -n "$INPUT_OUTPUT_DIRECTORY" ]; then
  case "$INPUT_OUTPUT_DIRECTORY" in
    /*) report_directory="$INPUT_OUTPUT_DIRECTORY" ;;
    *) report_directory="$RUNNER_TEMP/$INPUT_OUTPUT_DIRECTORY" ;;
  esac
else
  report_parent="$(mktemp -d "$RUNNER_TEMP/migration-doctor-action-report.XXXXXX")"
  report_directory="$report_parent/report"
fi

if [ -e "$report_directory" ] || [ -L "$report_directory" ]; then
  printf 'Report output already exists: %s.\n' "$report_directory" >&2
  exit 2
fi

tool_parent="$(mktemp -d "$RUNNER_TEMP/migration-doctor-action-tool.XXXXXX")"
tool_root="$tool_parent/source"
mkdir -m 700 "$tool_root"
tool_root="$(cd "$tool_root" && pwd -P)"
trap 'rm -rf "$tool_parent"' EXIT

action_source="$(cd "$MIGRATION_DOCTOR_ACTION_SOURCE" && pwd -P)"
git_root="$(git -C "$action_source" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$git_root" ] && [ "$action_source" = "$(cd "$git_root" && pwd -P)" ]; then
  git -C "$action_source" archive --format=tar HEAD | tar -xf - -C "$tool_root"
else
  for entry in \
    package.json \
    pnpm-lock.yaml \
    pnpm-workspace.yaml \
    tsconfig.base.json \
    tsconfig.json \
    migration.lock \
    data \
    packages
  do
    if [ ! -e "$action_source/$entry" ]; then
      printf 'Action source is missing required entry: %s.\n' "$entry" >&2
      exit 2
    fi
    cp -R "$action_source/$entry" "$tool_root/$entry"
  done
fi

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

printf 'exit-code=%s\n' "$status" >> "$GITHUB_OUTPUT"

bundle_complete=true
for report_file in \
  migration-report.md \
  migration-report.json \
  migration-report.sarif \
  migration-report.html
do
  if [ ! -f "$report_directory/$report_file" ]; then
    bundle_complete=false
  fi
done

if [ "$bundle_complete" = true ]; then
  printf 'report-directory=%s\n' "$report_directory" >> "$GITHUB_OUTPUT"
  printf 'sarif-path=%s\n' "$report_directory/migration-report.sarif" >> "$GITHUB_OUTPUT"
  if [ "$status" -le 1 ]; then
    exit 0
  fi
  exit "$status"
fi

if [ "$status" -le 1 ]; then
  printf 'Migration Doctor exited with %s without publishing a complete report bundle.\n' "$status" >&2
  exit 5
fi

exit "$status"

#!/usr/bin/env bash
# SessionStart hook: locate docs/HotStox/CLAUDE-shared.md (the cross-repo HotStox conventions)
# and tell Claude where it is. If it cannot be found, warn the user (systemMessage) and instruct
# Claude to stop and ask before doing anything else.
#
# CANONICAL COPY: alexanderkittelmann/docs HotStox/claude-hooks/shared-claude.sh.
# Every HotStox repo carries an identical copy in .claude/hooks/; edit the canonical one and copy it.
#
# Search order: $HOTSTOX_DOCS_DIR, a `docs` checkout next to the repo or next to any parent
# (covers .../hotstox/docs, .../akindustries/docs, .../akindustries/common/docs and the flat
# cloud layout /home/user/docs), then a cached shallow clone under ~/.cache/hotstox-docs
# (created / fast-forwarded here, non-interactive, 20 s cap).
#
# Skipped (no output) in headless automation: GitHub Actions / CI, the claude-runner (it routes
# every call through the backend BYOK proxy), or HOTSTOX_SKIP_SHARED_CLAUDE=1.

set -u
REL="HotStox/CLAUDE-shared.md"

if [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${CI:-}" ] || [ -n "${HOTSTOX_SKIP_SHARED_CLAUDE:-}" ]; then
  exit 0
fi
case "${ANTHROPIC_BASE_URL:-}" in *claude-proxy*) exit 0 ;; esac

cat > /dev/null 2>&1 || true   # drain the hook input JSON

project="${CLAUDE_PROJECT_DIR:-$PWD}"
# Git Bash on Windows hands over D:\...; normalise to a POSIX path.
if command -v cygpath > /dev/null 2>&1; then project="$(cygpath -u "$project")"; fi
found=""

check() { [ -f "$1/$REL" ] && found="$1"; }

if [ -n "${HOTSTOX_DOCS_DIR:-}" ]; then check "$HOTSTOX_DOCS_DIR"; fi

dir="$project"
i=0
while [ -z "$found" ] && [ "$i" -lt 4 ]; do
  parent="$(cd "$dir/.." 2>/dev/null && pwd)" || break
  [ "$parent" = "$dir" ] && break
  check "$parent/docs"
  if [ -z "$found" ]; then
    for sib in "$parent"/*/docs; do
      [ -z "$found" ] && [ -d "$sib" ] && check "$sib"
    done
  fi
  dir="$parent"
  i=$((i + 1))
done

if [ -z "$found" ]; then
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/hotstox-docs"
  export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
  run() { if command -v timeout > /dev/null 2>&1; then timeout 20 "$@"; else "$@"; fi; }
  if [ -d "$cache/.git" ]; then
    run git -C "$cache" pull -q --ff-only > /dev/null 2>&1 || true
  else
    mkdir -p "$(dirname "$cache")" 2>/dev/null
    run git clone -q --depth 1 https://github.com/alexanderkittelmann/docs "$cache" > /dev/null 2>&1 || true
  fi
  check "$cache"
fi

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

if [ -n "$found" ]; then
  file="$found/$REL"
  stamp="$(git -C "$found" log -1 --format=%cs 2>/dev/null || echo unknown)"
  ctx="HotStox shared conventions: $file (docs commit date $stamp). This file is part of this repo's instructions: read it completely with the Read tool before starting the task. If that read fails, tell the user before doing anything else."
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(json_escape "$ctx")"
else
  msg="HotStox shared conventions (docs/$REL) NOT FOUND - not next to this repo, not in HOTSTOX_DOCS_DIR, and no clone of alexanderkittelmann/docs was possible. Claude will ask before it starts."
  ctx="IMPORTANT: the HotStox shared conventions file docs/$REL could not be found or fetched. It holds rules this repo's CLAUDE.md relies on (commit style, board hygiene + IDs, HANDOVER format, PR + CI rules). Before doing ANY work, tell the user that it is missing and ask whether to continue with only the essentials block in CLAUDE.md, or wait until the docs repo is available (clone it next to this repo, set HOTSTOX_DOCS_DIR, or add alexanderkittelmann/docs to the cloud session)."
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(json_escape "$msg")" "$(json_escape "$ctx")"
fi
exit 0

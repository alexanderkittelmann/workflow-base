#!/usr/bin/env bash
# Claude Code hook: make sure every session has docs/HotStox/CLAUDE-shared.md (the cross-repo
# HotStox conventions), and STOP the session until the user explicitly agrees to go on without it.
#
# CANONICAL COPY: alexanderkittelmann/docs HotStox/claude-hooks/shared-claude.sh.
# Every HotStox repo carries an identical copy in .claude/hooks/; edit the canonical one and copy it.
#
# Wired twice in .claude/settings.json:
#   SessionStart       `shared-claude.sh start`  -> search; found: tell Claude the path,
#                                                   missing: warn the user (systemMessage)
#   UserPromptSubmit   `shared-claude.sh prompt` -> found: nothing; missing: BLOCK the prompt
#                                                   (exit 2, Claude never sees it) until the user
#                                                   sends a prompt containing the confirm phrase
#
# Search order: $HOTSTOX_DOCS_DIR, a `docs` checkout next to the repo or next to any parent
# (covers .../hotstox/docs, .../akindustries/docs, .../akindustries/common/docs and the flat
# cloud layout /home/user/docs), then a cached shallow clone under ~/.cache/hotstox-docs
# (created / fast-forwarded here, non-interactive, 20 s cap).
#
# Silent (no output, never blocks) in headless automation: GitHub Actions / CI, the
# claude-runner (it routes every call through the backend BYOK proxy), or
# HOTSTOX_SKIP_SHARED_CLAUDE=1.

set -u
REL="HotStox/CLAUDE-shared.md"
CONFIRM="OHNE-SHARED-WEITER"
mode="${1:-start}"

if [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${CI:-}" ] || [ -n "${HOTSTOX_SKIP_SHARED_CLAUDE:-}" ]; then
  exit 0
fi
case "${ANTHROPIC_BASE_URL:-}" in *claude-proxy*) exit 0 ;; esac

input="$(cat 2>/dev/null || true)"
session="$(printf '%s' "$input" | grep -o '"session_id" *: *"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')"
session="$(printf '%s' "${session:-nosession}" | tr -c 'A-Za-z0-9_-' '_')"
state_dir="${TMPDIR:-/tmp}/hotstox-shared-claude"
mkdir -p "$state_dir" 2>/dev/null
state="$state_dir/$session"

project="${CLAUDE_PROJECT_DIR:-$PWD}"
# Git Bash on Windows hands over D:\...; normalise to a POSIX path.
if command -v cygpath > /dev/null 2>&1; then project="$(cygpath -u "$project")"; fi
found=""

check() { [ -f "$1/$REL" ] && found="$1"; }

search() {
  if [ -n "${HOTSTOX_DOCS_DIR:-}" ]; then check "$HOTSTOX_DOCS_DIR"; fi
  local dir="$project" i=0 parent sib
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
  [ -n "$found" ] && return
  local cache="${XDG_CACHE_HOME:-$HOME/.cache}/hotstox-docs"
  export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
  run() { if command -v timeout > /dev/null 2>&1; then timeout 20 "$@"; else "$@"; fi; }
  if [ -d "$cache/.git" ]; then
    run git -C "$cache" pull -q --ff-only > /dev/null 2>&1 || true
  else
    mkdir -p "$(dirname "$cache")" 2>/dev/null
    run git clone -q --depth 1 https://github.com/alexanderkittelmann/docs "$cache" > /dev/null 2>&1 || true
  fi
  check "$cache"
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

if [ "$mode" = "prompt" ]; then
  # Already settled for this session: found, or the user confirmed going on without it.
  if [ -f "$state" ] && grep -qE '^(found|confirmed)' "$state"; then exit 0; fi
  search
  if [ -n "$found" ]; then
    echo "found $found" > "$state"
    # Appeared after SessionStart said it was missing: hand Claude the pointer now.
    printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' \
      "$(json_escape "HotStox shared conventions are now available: $found/$REL. Read it completely with the Read tool before starting the task.")"
    exit 0
  fi
  if printf '%s' "$input" | grep -qi -- "$CONFIRM"; then
    echo "confirmed" > "$state"
    printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' \
      "$(json_escape "The user confirmed continuing WITHOUT the HotStox shared conventions (docs/$REL). Work only with the essentials block in CLAUDE.md and say so when a decision would normally need the shared file (board IDs, PR rules, HANDOVER format).")"
    exit 0
  fi
  {
    echo "STOP: The HotStox shared conventions (docs/$REL) were not found, so this prompt was NOT sent to Claude."
    echo "Fix: clone alexanderkittelmann/docs next to this repo (or set HOTSTOX_DOCS_DIR), or add it to the cloud session, then resend the prompt."
    echo "To continue WITHOUT the shared conventions anyway, resend your prompt with the word $CONFIRM in it."
  } >&2
  exit 2
fi

# mode = start
search
if [ -n "$found" ]; then
  echo "found $found" > "$state"
  file="$found/$REL"
  stamp="$(git -C "$found" log -1 --format=%cs 2>/dev/null || echo unknown)"
  ctx="HotStox shared conventions: $file (docs commit date $stamp). This file is part of this repo's instructions: read it completely with the Read tool before starting the task. If that read fails, stop and ask the user whether to continue without it."
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(json_escape "$ctx")"
else
  echo "missing" > "$state"
  msg="HotStox shared conventions (docs/$REL) NOT FOUND. Every prompt is blocked until the docs repo is available or you include $CONFIRM in a prompt to continue without it."
  ctx="The HotStox shared conventions file docs/$REL could not be found. A UserPromptSubmit hook blocks prompts until the user explicitly confirms continuing without it. If you nevertheless receive a task, do not start it: tell the user the file is missing and ask whether to continue."
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(json_escape "$msg")" "$(json_escape "$ctx")"
fi
exit 0

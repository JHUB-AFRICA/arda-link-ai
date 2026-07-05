#!/usr/bin/env bash
#
# branch-hygiene.sh — report stale, merged, empty, and orphan branches.
#
# Usage:
#   scripts/branch-hygiene.sh                # human-readable report
#   scripts/branch-hygiene.sh --cleanup     # also print delete commands (still asks before running)
#   scripts/branch-hygiene.sh --json        # machine-readable
#
# The script never deletes anything. It only reports and (with --cleanup)
# prints the exact commands you would need to run. We don't auto-delete
# because losing a branch is irreversible and the script may misclassify
# a branch you actually care about.
#
# Protected branches (master, staging, dev) are never reported.

set -euo pipefail

PROTECTED="^(master|staging|dev|HEAD)$"
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

JSON=0
CLEANUP=0
for arg in "$@"; do
  case "$arg" in
    --json)   JSON=1 ;;
    --cleanup) CLEANUP=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
  esac
done

# Collect branch data.
branches=()
while IFS= read -r b; do
  [[ "$b" =~ $PROTECTED ]] && continue
  branches+=("$b")
done < <(git branch --no-color | sed 's/^[\* ] //' | grep -v '^$')

# Helper: get a field for a branch.
name()        { echo "$1"; }
last_sha()    { git rev-parse --short "$1"; }
last_date()   { git log -1 --format='%cs' "$1" 2>/dev/null; }
last_msg()    { git log -1 --format='%s' "$1" 2>/dev/null | head -c 60; }
ahead_dev()   { git rev-list --count "dev..$1" 2>/dev/null; }
behind_dev()  { git rev-list --count "$1..dev" 2>/dev/null; }
is_empty()    { [[ "$(git rev-list --count "$1..master" 2>/dev/null)" == "0" ]]; }
is_merged()   { git merge-base --is-ancestor "$1" dev 2>/dev/null; }
is_pushed()   {
  git ls-remote --heads origin "refs/heads/$1" 2>/dev/null | grep -q .;
}
has_unmerged() { [[ "$(ahead_dev "$1")" -gt 0 ]]; }

# Classify each branch.
declare -a rows=()
for b in "${branches[@]}"; do
  ahead=$(ahead_dev "$b")
  behind=$(behind_dev "$b")
  if is_empty "$b"; then
    class="EMPTY"
  elif is_merged "$b"; then
    class="MERGED"
  elif [[ "$ahead" -gt 0 ]]; then
    class="ACTIVE"
  else
    class="STALE"
  fi
  rows+=("$b|$class|$ahead|$behind|$(last_date "$b")|$(last_msg "$b")|$(is_pushed "$b" && echo yes || echo no)")
done

# Empty-repo shortcut.
if [[ ${#rows[@]} -eq 0 ]]; then
  echo "Nothing to report — repo is clean."
  exit 0
fi

# Output.
if [[ $JSON -eq 1 ]]; then
  echo "["
  for r in "${rows[@]}"; do
    IFS='|' read -r b cls ahead behind date msg pushed <<< "$r"
    printf '  {"branch":%s,"class":%s,"ahead_dev":%s,"behind_dev":%s,"last_commit":%s,"last_msg":%s,"pushed":%s}\n' \
      "$(printf '%s' "$b" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      "$(printf '%s' "$cls" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      "$ahead" "$behind" \
      "$(printf '%s' "$date" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      "$(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      "$([[ "$pushed" == "yes" ]] && echo true || echo false)"
  done
  echo "]"
  exit 0
fi

# Human-readable report.
echo "Branch hygiene report"
echo "Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Repo: $(basename "$REPO_ROOT")"
echo
printf "%-50s %-8s %-6s %-7s %-12s %s\n" "BRANCH" "CLASS" "AHEAD" "BEHIND" "LAST_COMMIT" "MSG"
printf "%-50s %-8s %-6s %-7s %-12s %s\n" "$(printf '%.0s-' {1..50})" "-----" "-----" "------" "-----------" "---"

# Count classes for the summary.
declare -A counts=([MERGED]=0 [STALE]=0 [EMPTY]=0 [ACTIVE]=0)
total=${#rows[@]}
i=0
for r in "${rows[@]}"; do
  IFS='|' read -r b cls ahead behind date msg pushed <<< "$r"
  printf "%-50s %-8s %-6s %-7s %-12s %s\n" \
    "$b" "$cls" "$ahead" "$behind" "$date" "$msg"
  counts[$cls]=$(( ${counts[$cls]:-0} + 1 ))
  i=$((i + 1))
done

echo
echo "Summary: $total non-protected branch(es) — " \
  "MERGED=${counts[MERGED]:-0}, STALE=${counts[STALE]:-0}, EMPTY=${counts[EMPTY]:-0}, ACTIVE=${counts[ACTIVE]:-0}"

if [[ ${#rows[@]} -eq 0 ]]; then
  echo "Nothing to report — repo is clean."
  exit 0
fi

# Optional: print cleanup commands.
if [[ $CLEANUP -eq 1 ]]; then
  echo
  echo "=== Suggested cleanup commands (DO NOT run blindly — review first) ==="
  for r in "${rows[@]}"; do
    IFS='|' read -r b cls ahead behind date msg pushed <<< "$r"
    case "$cls" in
      MERGED|EMPTY)
        if [[ "$pushed" == "yes" ]]; then
          echo "  git push origin --delete '$b' && git branch -d '$b'"
        else
          echo "  git branch -d '$b'"
        fi
        ;;
      STALE)
        echo "  # branch $b is behind dev by $behind — rebase or close"
        echo "  git checkout '$b' && git rebase dev && git push --force-with-lease"
        ;;
      ACTIVE)
        : # nothing
        ;;
    esac
  done
fi
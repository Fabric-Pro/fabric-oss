#!/usr/bin/env bash
# Feasibility of the proposal commit path on the shipped git (spec §7 step 9).
# Synthetic content only. Exit 0 means every check passed.
set -euo pipefail
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
export HOME="$W" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=protocol.file.allow GIT_CONFIG_VALUE_0=always
g() { git -c credential.helper= "$@"; }
ok() { echo "ok   $1"; } ; fail() { echo "FAIL $1"; exit 1; }
MAIL="$(printf '%s@%s' noreply example.com)"   # assembled: no address literal in the tree
V="$(g --version | awk '{print $3}')"; echo "git $V"
case "${REQUIRE_GIT_MINOR:-}" in "") ;; *) case "$V" in "$REQUIRE_GIT_MINOR".*) ok "git $V is $REQUIRE_GIT_MINOR.x";; *) fail "git $V is not ${REQUIRE_GIT_MINOR}.x";; esac;; esac
g init -q -b main "$W/src"; g -C "$W/src" config uploadpack.allowFilter true
g -C "$W/src" config uploadpack.allowAnySHA1InWant true
mkdir -p "$W/src/agents"; printf 'one\n' > "$W/src/agents/a.md"; printf 'keep\n' > "$W/src/other.md"
g -C "$W/src" add -A; g -C "$W/src" -c user.name=t -c "user.email=$MAIL" commit -qm base
BASE="$(g -C "$W/src" rev-parse HEAD)"
printf 'moved\n' > "$W/src/other.md"; g -C "$W/src" -c user.name=t -c "user.email=$MAIL" commit -qam moved
g clone -q --filter=blob:none --depth 1 --single-branch --branch main --no-tags --no-checkout "file://$W/src" "$W/c"
g -C "$W/c" fetch -q --depth 1 --no-tags origin "$BASE"; g -C "$W/c" update-ref --no-deref HEAD "$BASE"
export GIT_INDEX_FILE="$W/idx"
g -C "$W/c" read-tree "$BASE" && ok read-tree
BLOB="$(printf 'two\n' | g -C "$W/c" hash-object -w --no-filters --stdin)" && ok hash-object
printf '100644 %s\tagents/a.md\0' "$BLOB" | g -C "$W/c" update-index -z --index-info && ok update-index
TREE="$(g -C "$W/c" write-tree --missing-ok)" && ok write-tree
unset GIT_INDEX_FILE
export GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL="$MAIL" GIT_COMMITTER_NAME=Fabric GIT_COMMITTER_EMAIL="$MAIL"
export GIT_AUTHOR_DATE=2026-09-24T00:00:00Z GIT_COMMITTER_DATE=2026-09-24T00:00:00Z
C1="$(printf 'msg\n' | g -C "$W/c" -c commit.gpgSign=false commit-tree "$TREE" -p "$BASE" -F -)"
C2="$(printf 'msg\n' | g -C "$W/c" -c commit.gpgSign=false commit-tree "$TREE" -p "$BASE" -F -)"
[ "$C1" = "$C2" ] && ok "commit-tree reproducible" || fail "commit-tree reproducible"
[ "$(g -C "$W/c" diff-tree -r -z --raw --no-renames "$BASE" "$C1" | tr '\0' '\n' | grep -c .)" = 2 ] && ok diff-tree || fail diff-tree
B=fabric/instructions/cexample000000000000000a
g check-ref-format "refs/heads/$B" && ok check-ref-format
g -C "$W/c" push --porcelain --no-follow-tags "--force-with-lease=refs/heads/$B:" origin "$C1:refs/heads/$B" > "$W/p1" && ok "lease push creates"
g -C "$W/c" push --porcelain --no-follow-tags "--force-with-lease=refs/heads/$B:" origin "$C1:refs/heads/$B" > "$W/p2" 2>&1 || true
FLAG="$(grep -o "^[=!*]" "$W/p2" | head -1 || true)"
case "$FLAG" in "="|"!") ok "create-only at own SHA reported as existing (flag $FLAG)";; *) fail "create-only at own SHA: $(cat "$W/p2")";; esac
g -C "$W/c" push --porcelain --no-follow-tags "--force-with-lease=refs/heads/$B:" origin "$BASE:refs/heads/$B" > "$W/p3" 2>&1 || true
grep -q "^!" "$W/p3" && ok "create-only refused over another SHA" || fail "create-only over another SHA: $(cat "$W/p3")"
g init -q --bare "$W/tmp"
if g -C "$W/tmp" push --porcelain "--force-with-lease=refs/heads/$B:$BASE" "file://$W/src" ":refs/heads/$B" > /dev/null 2>&1; then
  fail "leased delete at a moved tip must be refused"; else ok "leased delete refused at other tip"; fi
g -C "$W/tmp" push --porcelain "--force-with-lease=refs/heads/$B:$C1" "file://$W/src" ":refs/heads/$B" > /dev/null && ok "leased delete"
LR="$(g -C "$W/tmp" ls-remote --refs -- "file://$W/src" "refs/heads/$B")" || fail "ls-remote exited non-zero"
[ -z "$LR" ] && ok "ls-remote absent" || fail "ls-remote absent: $LR"
echo "all checks passed"

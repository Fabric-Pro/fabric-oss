#!/usr/bin/env bash
# Rule logic behind the "Relay title preflight" workflow
# (.github/workflows/relay-title-preflight.yml). Keep these rules in sync with
# the ops relay's create-synthetic-commit.sh (private ops repo,
# Fabric-Pro/fabric, lines 24-31 as of 2026-09-23): the relay builds the
# public squash commit's synthetic message from this repository's PR title,
# and refuses the whole relay -- after the PR has already consumed a public
# validation slot, roughly 15 minutes -- if the title breaks any of these
# rules. This script lets a PR author, and the co-located self-test in
# test.sh, catch that before the relay does.
#
# Usage: PR_TITLE=<title> tooling/relay-title-preflight/check.sh
#
# The title MUST arrive through the PR_TITLE environment variable, never as a
# command-line argument and never interpolated into this script. A PR title
# is attacker-controlled text; passing it any other way risks it being
# reinterpreted as shell syntax.
#
# Character counting: this counts the title's length with bash's `${#var}`
# under LC_ALL=C.UTF-8, which counts (multi-byte) characters rather than
# bytes. The script exports that locale itself so the count does not depend
# on the caller's environment: it is what lets a verdict here match the
# relay's own later verdict.
#
# Injection safety: nothing below ever echoes the title (or any substring of
# it) to stdout. GitHub's legacy log-command parser (`##[...]`) and the
# `::name::` workflow-command syntax match anywhere within a line of a job's
# log output, not just at the start -- so a title containing, say,
# `##[error]forged` or `::add-mask::...` could forge annotations or mask
# arbitrary later output if it were ever echoed verbatim. Every message this
# script prints is either a fixed sentence or reports only a derived number
# (a character count); none ever quotes the title's own text.
#
# Rules (all must hold):
#   1. single-line            -- the title contains no embedded newline.
#   2. non-blank               -- non-empty after trimming leading/trailing
#                                  whitespace.
#   3. max-length               -- at most 120 characters, counted on the
#                                  RAW title (before trimming) -- a leading
#                                  or trailing space counts toward the
#                                  limit, matching how the relay counts.
#   4. no-control-characters    -- no control character in the relay's
#                                  sense. Checked two ways so the verdict
#                                  does not depend on which locale the
#                                  runner's grep happens to favor: (a) a
#                                  locale-aware `[[:cntrl:]]` match under
#                                  LC_ALL=C.UTF-8, mirroring the relay's own
#                                  locale-aware check; and (b) an explicit,
#                                  locale-independent byte-level match for
#                                  DEL (0x7F) and every C1 control
#                                  U+0080-U+009F (encoded in UTF-8 as
#                                  0xC2 0x80-0x9F). Together these are at
#                                  least as strict as the relay's own check;
#                                  a title that passes here may still be
#                                  refused only if the relay's rules change.
#   5. forbidden-phrase         -- must not contain, case-insensitively, any
#                                  of: signed-off-by, co-authored-by,
#                                  submitted-on-behalf-of,
#                                  "BEGIN PGP SIGNATURE", "BEGIN SSH
#                                  SIGNATURE". The relay reserves these
#                                  tokens for its own synthetic
#                                  attribution trailer and signature blocks;
#                                  a PR title that carries one would forge or
#                                  corrupt that trailer.
#
# Exit 0 and print a fixed pass sentence (never any part of the title) when
# every rule holds. Exit 1 and print one `::error::` per violated rule --
# each line names the rule (`rule: <name>`) and tells the author what to
# change, without quoting the title or reporting anything about it beyond a
# plain number -- when any rule fails.

set -uo pipefail

export LC_ALL=C.UTF-8

TITLE="${PR_TITLE-}"
STATUS=0

trim() {
	local s="$1"
	s="${s#"${s%%[![:space:]]*}"}"
	s="${s%"${s##*[![:space:]]}"}"
	printf '%s' "$s"
}

TRIMMED="$(trim "$TITLE")"

# --- Rule: single-line ------------------------------------------------------
if [[ "$TITLE" == *$'\n'* || "$TITLE" == *$'\r'* ]]; then
	echo "::error::Relay title check failed (rule: single-line): the PR title must be exactly one line. Remove the embedded line break so the whole title sits on one line."
	STATUS=1
fi

# --- Rule: non-blank ---------------------------------------------------------
if [[ -z "$TRIMMED" ]]; then
	echo "::error::Relay title check failed (rule: non-blank): the PR title is empty, or only whitespace. Give the PR a real, descriptive title."
	STATUS=1
fi

# --- Rule: max-length (120 characters, counted on the RAW title) ------------
# Deliberately ${#TITLE}, not ${#TRIMMED}: the relay counts the raw title, so
# a leading or trailing space counts toward the 120-character limit here too.
LEN=${#TITLE}
if ((LEN > 120)); then
	echo "::error::Relay title check failed (rule: max-length): the PR title is $LEN characters (counted before trimming); the relay allows at most 120. Shorten the title."
	STATUS=1
fi

# --- Rule: no-control-characters ---------------------------------------------
# Two independent checks (see header): a locale-aware class match, plus an
# explicit byte-level match that does not depend on the runner's locale
# tables classifying every control character the same way. Either one
# tripping is the same violation, so they are OR'd into a single error.
LOCALE_AWARE_HIT=0
printf '%s' "$TITLE" | LC_ALL=C.UTF-8 grep -q '[[:cntrl:]]' && LOCALE_AWARE_HIT=1

EXPLICIT_HIT=0
# \x7f matches DEL; \xc2[\x80-\x9f] matches every C1 control U+0080-U+009F in
# its 2-byte UTF-8 encoding. LC_ALL=C keeps this a literal byte-level match
# (no UTF-8 decoding by grep itself), so it cannot be confused by locale.
printf '%s' "$TITLE" | LC_ALL=C grep -qP '\x7f|\xc2[\x80-\x9f]' && EXPLICIT_HIT=1

if [[ "$LOCALE_AWARE_HIT" -eq 1 || "$EXPLICIT_HIT" -eq 1 ]]; then
	echo "::error::Relay title check failed (rule: no-control-characters): the PR title contains a control character (for example a tab, carriage return, DEL, or another non-printable byte). Retype the title using ordinary printable characters and plain spaces only."
	STATUS=1
fi

# --- Rule: forbidden-phrase ---------------------------------------------------
FORBIDDEN=(
	"signed-off-by"
	"co-authored-by"
	"submitted-on-behalf-of"
	"BEGIN PGP SIGNATURE"
	"BEGIN SSH SIGNATURE"
)
LOWER_TITLE="$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]')"
for phrase in "${FORBIDDEN[@]}"; do
	lower_phrase="$(printf '%s' "$phrase" | tr '[:upper:]' '[:lower:]')"
	if [[ "$LOWER_TITLE" == *"$lower_phrase"* ]]; then
		echo "::error::Relay title check failed (rule: forbidden-phrase): the PR title contains \"$phrase\", which the relay reserves for its own synthetic commit trailer or signature block. Remove it from the title."
		STATUS=1
	fi
done

if [[ "$STATUS" -eq 0 ]]; then
	# Fixed sentence, deliberately not including the title or any derived
	# text from it -- see the "Injection safety" note above.
	echo "Relay title check passed."
fi

exit "$STATUS"

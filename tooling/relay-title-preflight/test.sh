#!/usr/bin/env bash
# Self-test for tooling/relay-title-preflight/check.sh. Run directly:
#   tooling/relay-title-preflight/test.sh
#
# Exercises every rule in check.sh (see its header for the rule list) against
# a known-good title and one deliberate violation per rule, then asserts both
# the exit code and that the right rule name appears in the output. POSIX-ish
# bash, no dependencies beyond coreutils/grep -- the same constraint check.sh
# itself holds to.
#
# Exit 0 when every case behaves as expected; otherwise exit 1 after printing
# every failing case (not just the first).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/check.sh"

CASES=0
FAILURES=0

# run_case NAME EXPECTED_EXIT EXPECT_RULE TITLE
#
# EXPECT_RULE is the rule name (e.g. "max-length") that must appear as
# "rule: <name>" in the output. Pass "" for a passing case, which instead
# asserts the output reports the fixed pass sentence (never the title).
run_case() {
	local name="$1" expected_exit="$2" expect_rule="$3" title="$4"
	CASES=$((CASES + 1))

	local output
	output="$(PR_TITLE="$title" "$CHECK" 2>&1)"
	local actual_exit=$?

	if [[ "$actual_exit" -ne "$expected_exit" ]]; then
		echo "FAIL [$name]: expected exit $expected_exit, got $actual_exit"
		echo "  output: $output"
		FAILURES=$((FAILURES + 1))
		return
	fi

	if [[ -n "$expect_rule" ]]; then
		if ! grep -qF "rule: $expect_rule" <<<"$output"; then
			echo "FAIL [$name]: expected an error naming rule '$expect_rule'; got:"
			echo "  $output"
			FAILURES=$((FAILURES + 1))
			return
		fi
	else
		if ! grep -qF "Relay title check passed." <<<"$output"; then
			echo "FAIL [$name]: expected a passing run to print the fixed pass sentence; got:"
			echo "  $output"
			FAILURES=$((FAILURES + 1))
			return
		fi
		if grep -qF "$title" <<<"$output" && [[ -n "$title" ]]; then
			echo "FAIL [$name]: passing output must never contain the title itself; got:"
			echo "  $output"
			FAILURES=$((FAILURES + 1))
			return
		fi
	fi

	echo "PASS [$name]"
}

# 1. A good title passes cleanly.
run_case "good title" 0 "" "Fix retry backoff for OSS relay in sync mode"

# 2. Exactly 121 characters trips max-length (120 is the limit).
run_case "121-character title" 1 "max-length" "$(printf 'a%.0s' {1..121})"

# 3. An embedded newline trips single-line.
run_case "two-line title" 1 "single-line" "$(printf 'First line\nSecond line')"

# 4. Whitespace-only trips non-blank.
run_case "blank title" 1 "non-blank" "   "

# 5-9. Each forbidden phrase, in mixed case, trips forbidden-phrase.
run_case "signed-off-by mixed case" 1 "forbidden-phrase" "Fix relay title SiGnEd-OFF-by nonsense"
run_case "co-authored-by mixed case" 1 "forbidden-phrase" "Title with a Co-AUTHORED-by token"
run_case "submitted-on-behalf-of mixed case" 1 "forbidden-phrase" "Title Submitted-ON-Behalf-Of someone"
run_case "BEGIN PGP SIGNATURE mixed case" 1 "forbidden-phrase" "Title with begin pgp signature block"
run_case "BEGIN SSH SIGNATURE mixed case" 1 "forbidden-phrase" "Title with Begin Ssh Signature block"

# 10. A tab character trips no-control-characters.
run_case "tab character" 1 "no-control-characters" "$(printf 'Title with a\ttab')"

# 11. Exactly 120 ASCII characters passes (the boundary itself is fine).
run_case "exactly 120 ASCII" 0 "" "$(printf 'a%.0s' {1..120})"

# 12. A leading space plus 120 characters is 121 RAW characters and must
# fail on length -- the relay counts the raw title, not the trimmed one, so
# this must NOT be let through just because the trimmed title is 120.
run_case "leading space + 120" 1 "max-length" " $(printf 'a%.0s' {1..120})"

# 13. A bare carriage return trips no-control-characters (it also trips
# single-line, which is fine -- this case only asserts the former).
run_case "CR" 1 "no-control-characters" "$(printf '\r')"

# 14. DEL (0x7F) trips no-control-characters via the explicit byte check.
run_case "DEL" 1 "no-control-characters" "$(printf '\x7f')"

# 15. A 120-code-point multibyte title passes: ${#var} under LC_ALL=C.UTF-8
# counts characters, not bytes, matching the relay's own counting.
run_case "multibyte 120 code points" 0 "" "$(printf 'é%.0s' {1..120})"

# 16. U+0085 (NEL) is a C1 control the relay's locale-aware check catches;
# this is exactly the byte this rule was tightened to catch (see check.sh
# header). It is not \n or \r, so this isolates no-control-characters.
run_case "U+0085 (NEL)" 1 "no-control-characters" "$(printf '\u0085')"

# 17. U+009F, the last C1 control, exercises the top of the explicit
# U+0080-U+009F byte range.
run_case "U+009F" 1 "no-control-characters" "$(printf '\u009f')"

echo
echo "$CASES case(s) run, $FAILURES failure(s)."
if [[ "$FAILURES" -ne 0 ]]; then
	exit 1
fi
exit 0

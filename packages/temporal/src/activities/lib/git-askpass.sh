#!/bin/sh
# GIT_ASKPASS helper for the Coding Instructions repository sync
# (design 2026-09-23 section 8.1, hardened per review S3, anchored per review
# S3 fix round 2). git runs it with the prompt as $1. The username and the
# credential come from the git child's environment only, so no secret is
# ever in argv, in .git/config, or on disk.
#
# The prompt must also name the expected host ($FABRIC_GIT_HOST) as either
# the URL authority (//host': ) or the userinfo target (@host': ), so a
# credential prompt raised for a different host -- a cross-host redirect, or
# an HTTPS_PROXY that itself demands auth -- gets an empty answer instead of
# the repository token.
#
# Both patterns are anchored to the END of the prompt (git's own format is
# "Username for '<url>': " / "Password for '<url>': ", always ending in the
# literal "': "; verified against git 2.55's credential.c and this file's own
# tests). An unanchored *"//$FABRIC_GIT_HOST'"* would also match a userinfo
# segment forged to CONTAIN the expected host earlier in the string, e.g.
# "Password for 'https://github.com'@<attacker host>': " for FABRIC_GIT_HOST=
# github.com -- the real authority there is the attacker's host, at the end,
# not the spoofed github.com in the middle.
case "$1" in
	*"//$FABRIC_GIT_HOST': " | *"@$FABRIC_GIT_HOST': ")
		case "$1" in
			Username*) printf '%s\n' "$FABRIC_GIT_USERNAME" ;;
			*) printf '%s\n' "$FABRIC_GIT_CREDENTIAL" ;;
		esac
		;;
	*) printf '\n' ;;
esac

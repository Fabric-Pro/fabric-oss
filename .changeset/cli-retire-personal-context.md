---
"@fabricorg/cli": minor
"fabric-app": patch
---

The command-line client retires personal context

`--personal`, `FABRIC_PERSONAL=1` and `fabric ctx use personal` selected a context that no longer exists. All three are now refused with a message naming what replaced them, and the query parameter they produced is gone from every command.

The flag and the subcommand are kept REGISTERED rather than deleted. Someone with either in a script meets an explanation instead of "unknown option", which is the difference between a migration and a break. `fabric ctx current` reports a stored personal default as needing replacing rather than printing it as though it still worked, and rather than reporting "none" — it is set, the user can see it is set, and calling it unset would send them hunting for a setting that is right there.

A config written by an earlier version still parses. A client that crashed on its own config file would be a worse failure than the one being fixed.

Refusals exit 2, as every other context error does.

---
"fabric-app": patch
---

Rename the CLI-connection readiness item so its name says which scope it reports.

The item completes when any credential in an organization reaches Fabric over
MCP, so one person connecting completes it on every project in that
organization — including projects whose owner configured nothing. That was
stated in the item's description and tooltip, and it was still read as a
per-project claim, because the recently-completed list renders the item's name
alone: no description, no tooltip, no hover. "API Key for CLI" under a project
heading, beside project-scoped items like "Chat app connected", says something
the item does not mean.

The item is now called "Organization connected over MCP". It reads the same way
whether it is an outstanding goal or a finished fact, it names the scope without
an expand or a hover, and it drops "API Key" and "CLI": a key existing is not
what completes it, and the runtime records no client identity, so it cannot know
whether a CLI, a desktop assistant or a script did the reaching.

No behaviour changes. The item completes on exactly the evidence it did before.

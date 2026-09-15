---
"fabric-app": patch
---

"Show me" for MCP servers points at the sidebar row again, so it works from any page rather than only from the MCP servers tab.

Reverts one part of the Fizzy #2504 follow-up, verified on staging.

The drawer item had been re-anchored from `nav-integrations` to the in-page
`mcp-servers-add-registry` so the highlight would name MCP rather than a row
labelled Connections. On the MCP tab that worked. Everywhere else it did not:
an `anchor` target never navigates — `navigate` only fills the "Take me there"
CTA, and auto-navigation exists solely for `projectTab`/`projectComponent`
targets (`GetStartedSpotlight.tsx`). So the anchor was simply absent, the
spotlight timed out into a centered card, and "Take me there" then landed on
the tab without scrolling to the card or highlighting it.

The original anchor was also the intended answer rather than a mismatch: the
card is titled "Where it lives", and MCP servers genuinely is reached through
the Connections row. Sharing that row with the item above it is the answer.

The reasoning is now recorded at the entry so the same change is not attempted
a third time. The other three repairs from that follow-up are unaffected: the
MCP tab still opens its own walkthrough, `/mcp-servers` still lands directly,
and the dead `MCPServersHero` stays deleted.

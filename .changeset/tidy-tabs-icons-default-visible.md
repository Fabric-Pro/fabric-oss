---
"fabric-app": patch
---

Every project tab is now visible by default, and the tab bar shows icons with the tab name on hover.

Fizzy #1837 follow-up, from the reviewer's comment on the card: Atlas, Security, Decisions and
Publishing Suite used to start hidden, which read as "hidden by project admin" in the Customize
dialog with no obvious way to switch them on. The default-hidden set is gone — a project shows
every tab the deployment offers until an admin turns one off in Settings -> General -> Tab
visibility, and the dialog's "Unavailable in this project" section now names that path.

The bar itself is icon-only to keep a long tab list readable. The selected tab keeps its label
inline (the only textual "you are here"); every other tab carries its name as the button's
aria-label and surfaces it in a tooltip on hover or keyboard focus. Agent Activity moves off the
robot icon it shared with Coding Agents, which was indistinguishable once labels came off.

Resolution drops a layer: the admin override map and the viewer's own preferences are all that
narrow the deployment's offered set. The per-tab button moved out of ProjectDetails into
ProjectTabButton so the icon-only contract is unit-tested directly.

---
"fabric-app": patch
---

Publishing Suite topic pages now show content types as a second row of the same tab strip instead of a separate block below every tab

Fizzy #1851. The generation strip was a sibling of the whole `<Tabs>` element, so it rendered under Summary & Questions, Planning & Analysis AND Decision Log — two tab strips on screen at once, with the content generation the user came for sitting below everything else.

`GenerationTabs` splits into three exports: `buildGenerationTabModel` (state derived once), `GenerationTabTriggers` (row 2) and `GenerationTabPanels` (content). The page owns one `<Tabs>` with two `TabsList` rows driving ONE selection, so a content type is a peer of a review tab rather than a tab inside a tab.

Row 1 is reordered to `Summary & Questions | Decision Log | Planning & Analysis`, matching the Feature Item Page. FR6 still holds — Summary & Questions is the default tab, which was never the same thing as being first.

Row 2 narrows to the content types the topic selected (the user's override when set, the AI suggestion otherwise), so "Edit post types" now has a visible consequence. Empty falls back to all four: #1853 FR1/FR2 activate the generation tabs unconditionally, and topics created before 1B started writing `suggestedPostTypes` — plus every manually-created topic — have no selection to narrow to.

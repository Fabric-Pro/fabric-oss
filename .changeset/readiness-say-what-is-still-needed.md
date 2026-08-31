---
"fabric-app": patch
---

Readiness checklist items now say what is still needed, not only why they matter.

All 26 tooltips are the checklist spreadsheet's copy, and every one of them explains an item's
value rather than its condition. On a rule with more than one condition that leaves a user who has
done half the work unable to tell which half is missing: a project connected to a PM system reads
"sync keeps Fabric and your project management system aligned" while silently waiting on the
auto-push toggle. Two detection bugs hid in exactly that gap.

Thirteen rules now carry an `unmet` branch beside their `detect`, naming the first condition
standing in the way, rendered as a third line under the sheet's tooltip. The spreadsheet copy is
untouched — this sits beneath it, and only the wording is translated; the branching lives next to
the detection it describes so the two cannot drift apart in separate files.

Three of them disambiguate rather than instruct, because the item's own name points somewhere
wrong: QA Strategy wants a document and not the Testing tab or Settings -> Testing; Wiki Connected
wants Notion, which Confluence cannot satisfy; Knowledge Base wants one specific category out of
eight. Others name a threshold the panel never showed — a second context source, a member who has
actually accepted, a scan that finished rather than one that ran.

Guarded by a test that brute-forces every branch each rule can return and asserts copy exists for
it, so a new branch without copy fails rather than rendering a raw key path. The call-to-action
labels shipped once with all 26 keys wrong and nothing caught it.

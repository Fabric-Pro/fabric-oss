---
"fabric-app": patch
---

Publishing Suite topics now show their age, stale suggestions sink to the bottom of the queue, and the list is searchable

Fizzy #1851. Topic rows carried no date at all, so a suggestion from yesterday and one sitting untouched since July looked identical — and the queue only ever grew.

Rows now show relative age with the exact timestamps on hover, mirroring the roadmap. A suggestion nobody has touched for 30 days is labelled "Stale for N days", muted, and sunk to the bottom of Suggested. Nothing is hidden: snoozed topics are required to re-surface on schedule, and a staleness filter would re-hide exactly the ones that requirement exists to bring back. The label says it in words rather than only in colour.

The Suggested section's per-viewer ranking is preserved — the sink is a stable partition over the incoming order rather than a re-sort, so topics you contributed to still come first within each group.

"Matches your role" moves onto the collapsed row: it was already computed for every row and only hidden behind the expander. Search covers title, angle and pitch across every status, including declined and snoozed topics that neither Inbox section shows — a topic you declined last month is exactly what you reach for search to find.

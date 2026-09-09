---
"fabric-app": patch
---

Let a reader choose how their Inbox is sorted and laid out, and remember it

*"Lets have option to change sorting and remember user's preference so when he revisits its the same for him"*, and *"maybe lets have an option to change view"* (Fizzy #1851).

Sort offers **Recommended**, **Recently updated** and **Recently created**; layout offers one column or two. Both are stored per user per project — the same pattern project tab customization already uses, because the same person reasonably works differently on a busy project and a quiet one, and one global row would make one of them wrong.

**Recommended stays the default**, and that is the load-bearing choice. The incoming order is 1B's per-viewer ranking, which already floats a reader's own beat to the top; defaulting to a date would silently switch personalization off for everyone who never opens the control, which is most people.

**The sort applies to the live head and to nothing else.** The aging band is ordered by how long each topic has been quiet, and that ordering *is* the sink — re-sorting the tail by date would undo the thing the control sits above. Archived never renders in order at all.

The controls appear only while the sections are on screen: a search or a status chip replaces them with one flat list this sort does not order, and leaving it there would misdescribe what it does. Two columns collapses to one below `lg:`, where each would be too narrow for a title and a pitch.

A reader with no stored row is not a special case: the query returns the defaults, so absence and "the defaults" are the same state and nothing writes on read. Writes are partial, so changing the sort cannot silently reset a layout somebody chose last week. The row is registered for RLS as per-user-within-org, like the topic read markers — a colleague's preference is not another member's business.

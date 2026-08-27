---
"fabric-app": patch
---

Readiness checklist: show when an item's work is already running, and finish without a page refresh. Also restores the callout behaviour a merge had reverted.

"In Progress" is listed as an item state in the checklist spreadsheet's Definitions tab and was asked for on the 25 August call, watching a knowledge base crawl: *"it should indicate that it's processing"*. An item now says so while the work that would satisfy it is underway — a context source still extracting, a repository indexing, a document generating, a scan running — and keeps its actions, so a long crawl does not take the controls away.

Each rule's in-progress test mirrors its own detect, so an item can only claim to be underway about work that would actually complete it. A marketing link being scanned no longer makes the Knowledge Base row claim to be in progress.

The panel polls while anything is in progress and stops the moment nothing is. Indexing and generation land minutes after the click that started them with no mutation on this client to notice, which is the case neither the mutation-cache subscription nor the tab-change listener could cover — the last of the three refresh paths.

Also restores the checklist callout: #3180 branched before #3177 merged and carried the older panel file wholesale, which put back the extra "Show me" control and stopped the item's own action raising the callout.

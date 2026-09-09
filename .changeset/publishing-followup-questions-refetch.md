---
"fabric-app": patch
---

Show the questions a finished planning analysis raised, without waiting for a reload

Reported from staging on 9 September (Fizzy #1851): a topic whose planning analysis had completed still read "No open questions yet. They arrive with the planning analysis."

They had arrived. Questions are minted server-side at exactly the moment a run completes — `reconcileTopicQuestions` runs inside `completePlanningAnalysis`, in the same transaction that makes the analysis READY. But the topic page's decisions query is a plain query with no refetch interval, so it was fetched once on mount, came back empty because the run had not happened yet, and nothing ever asked again. The app's 60-second `staleTime` meant even revisiting the tab did not refetch; only a refocus or a reload did.

The page contradicted itself in a single frame, which is what makes it worth stating plainly: the format tabs showed "Recommended" badges — read off the analysis query, which polls while a run is in flight and had refetched — beside a panel insisting no questions existed.

The decisions query is now invalidated when a run leaves `GENERATING`, keyed on the transition rather than on the terminal status, since an effect firing on "READY" would re-fire on every later refetch of a finished analysis and invalidate in a loop. A failed run counts too: reconciliation may have soft-closed questions the previous run raised, and a stale question set is worse than an explained failure.

---
"fabric-app": patch
---

Show a saved analysis revision in History without a reload, and stop offering a restore that changes nothing

Three defects reported from staging on 9 September (Fizzy #1851), one of which reaches every version history in the app.

**A save did not reach the version list.** `refreshAnalysis` invalidated `getPlanningAnalysis` and nothing else, but the History drawer's revision list is a separate infinite query. So saving an edit left History showing a list without the revision it had just written, and the app's 60-second `staleTime` meant closing and reopening the drawer did not refetch either — only a full page reload, which builds a fresh cache, made it appear. Restore had always invalidated both; an ordinary Save had not. The list is invalidated with `key()` rather than `queryKey()`, because it is an infinite query and the `type: "query"` stamp the latter adds matches nothing at runtime while looking correct in the source.

**"Restore Version 1" reported restoring version 2 and changed nothing.** The version list already hides its Restore button on the current row, but the fullscreen diff viewer — reachable by clicking that same row — did not. Pressing it wrote a new revision holding the body the document already had, and the toast named the row it had just minted rather than the one on the button. Restore is now hidden whenever restoring would change nothing, keyed on the bodies being identical rather than on the version numbers matching, so an older revision whose text happens to match the current one is covered by the same rule. This is in the shared `VersionDiffViewer`, so document and feature histories get the same fix.

**"No differences found" on the current version now says what it means.** Comparing the current row against itself is not a failed comparison, and reading it as one is what made the restore look broken rather than pointless.

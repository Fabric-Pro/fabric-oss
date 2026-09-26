---
"fabric-app": patch
---

Adding new detail to an existing work item no longer turns characters such as &, < and quotes into HTML codes like &amp; in its description or acceptance criteria.

The structure-preserving merge rendered its bound prompts with Handlebars double-stache, which HTML-escapes the ticket text; the model then copied `&amp;`, `&lt;` and `&quot;` into the merged body written back to the ticket. `renderTemplate` gains an `escape` option (default unchanged) and the merge renders with `escape: false`.

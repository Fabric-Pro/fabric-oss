---
"fabric-app": patch
---

Roadmap keyword search now lists the work items your query names and collapses description-only matches behind a count you can expand.

Follow-up to the roadmap search relevance work (Fizzy #1937). Relevance ranking sorted title
matches to the top but still listed every description hit, so a query whose words are common
in prose returned a long tail of unrelated rows — reported as search "generating multiple
unrelated results".

Ranking reorders; it never shortens. This adds the narrowing step: when at least one result
matches by name (title, identifier or PM-tool externalId), only those are listed, and the
body-only rows collapse into a "N more match in description" control beside the result count
— the same bargain the hidden-item count already makes. When nothing matches by name the full
list is returned unchanged, so a description search never faces an empty roadmap.

AI (semantic) search is deliberately not narrowed: it exists to find items whose titles share
no words with the query. The semantic-empty keyword fallback IS narrowed, because that path is
keyword ranking.

The hidden-match count is gated on the same runs as the visible list, so it can no longer
promise more rows than revealing hidden actually shows.

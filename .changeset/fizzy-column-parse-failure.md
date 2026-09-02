---
"fabric-app": patch
---

Stop a Fizzy board pull from silently dropping a column whose card listing cannot be read

Fizzy #1997 follow-up found by post-ship review. The board listing fetches cards one column at a time; a column whose response came back as unparseable text (rate-limit notice, HTML error page, truncated body) was swallowed as "no cards" with no throw and no log. The listing then returned short but non-empty, so the board-is-empty guard never fired and the full pull's orphan cleanup deleted the stories of cards that still exist. The parser now fails loudly and the pull falls back to the generic paged path, which was hardened the same way earlier in this ticket.

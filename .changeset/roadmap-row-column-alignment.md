---
"fabric-app": patch
---

Keep the roadmap's status, source, tag and PM sync columns lined up across every row, whether or not a row has tags.

Each roadmap row renders its optional fields as fixed-width cells anchored to the kebab on the right, so the cells form straight columns only while every row renders the same set of them. The tags cell broke that: a row with no tags returned no cell at all, so a tagged row carried one extra 10rem cell and its status, size and source cells sat that much further left than on every untagged row. With the default column order the tagged row's status and source visibly jumped out of line, which read as "a tag on the top item breaks the table".

The early return was left behind when the custom-tags feature flag was removed: the original guard hid the cell when the flag was off or the row had no tags, and only the flag half was deleted. An untagged row now renders the empty cell like every other column does.

A StoryCard test pins the contract: a row without tags renders the same ordered sequence of column cells, with the same widths, as a tagged row.

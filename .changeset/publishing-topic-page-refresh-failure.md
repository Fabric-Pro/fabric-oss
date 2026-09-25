---
"fabric-app": patch
---

Publishing Suite: a topic page whose background refresh fails now keeps the topic on screen with Try again, instead of saying it was not found.

Fizzy #2647. The topic page re-reads `getTopic` in the background often, not only after a status change: a status write (Fizzy #2646), any other metadata write (post types, contributors, assignees, the summary, the private notes), and TanStack Query's own refetch-on-focus and refetch-on-reconnect all trigger one, and the query client's global `retry: false` means one failed refetch is enough to trip it. The page's not-found branch fired on `isError || !topic`, and TanStack Query keeps the last successful data on a failed refetch rather than clearing it, so a topic already on screen — with its status control and Saving/Saved/Not saved note — vanished under "Topic not found" instead of staying up. `NOT_FOUND`, `FORBIDDEN` and `UNAUTHORIZED` (a denylist, including oRPC's status-mapped equivalent for a non-oRPC 401/403/404) still show "Topic not found", since those are genuine access refusals; any other error, or none, now keeps the page and shows an inline alert with a Try again button that calls `refetch()`.

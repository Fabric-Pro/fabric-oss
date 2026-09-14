---
"fabric-app": patch
---

A GitLab token refresh that takes a few seconds no longer has its database transaction pulled out from under it, which was retiring the stored credentials and forcing a reconnect.

All four GitLab refresh paths run the OAuth token exchange inside the Postgres advisory lock that serializes refreshes across processes — deliberately, because GitLab rotates the refresh token single-use and two callers exchanging the same one means the loser is rejected. Three of them opened that transaction directly and gave it no explicit budget, so they ran under the database client's 5s default; the fourth goes through the shared lock helper, which already allowed 20s. All four held a provider round-trip that had no timeout of its own.

Once a transaction passed its deadline it was rolled back and the lock released while the exchange was still in flight. GitLab could then still honour it — rotating and invalidating the old refresh token — while the write that stores the new one never ran. The connection was left holding a token GitLab had already retired, so the next refresh was rejected and the connection was marked as needing re-authentication; a second process could also enter the exchange window with the same retired token.

The three inline transactions now carry the same explicit budget the shared helper and the GitHub paths already used, all four take it from one shared definition, and each of those four refresh exchanges is bounded well inside it. A caller that has spent most of the budget waiting for the lock now declines to start an exchange it could not finish, and fails transiently for the next attempt to retry, instead of starting one the deadline would cut off.

What this does not change: a provider that accepts an exchange but answers too slowly is an outcome nobody can observe. Giving up locally cannot un-rotate a token GitLab already rotated, so that window still exists — it is just no longer entered by a five-second deadline on an exchange that was always going to take longer.

Tests: every refresh path asserts the transaction budget it passes, an exchange that times out is pinned as an ordinary failure rather than a dead-grant verdict, a caller whose budget is gone but whose credentials were refreshed by someone else still succeeds without contacting the provider, and the budget arithmetic — transaction window against the bounded calls made inside it — is asserted so shrinking either number fails a test instead of production.

---
"fabric-app": patch
---

Stop the project readiness checklist re-fetching on every re-render after a mutation succeeds.

`ProjectReadinessProvider` subscribed to the TanStack Query mutation cache and refetched
readiness whenever it saw a mutation whose *current state* was "success" — but `useMutation`
re-announces its options via an `observerOptionsUpdated` cache event on every render of any
component with an inline `mutationFn`/`onSuccess`, and once such a mutation has succeeded once
that event keeps passing the old filter forever after. In production this produced roughly
7,000 `projects.readiness.get` calls in 6 hours, each running about 20 DB queries. The filter
now keys on the event type (`type === "updated" && action.type === "success"`) instead of
mutation state, and the debounced refetch waits for an in-flight request to finish rather than
cancelling it, so a burst of real mutations costs one request and still reads post-commit data.

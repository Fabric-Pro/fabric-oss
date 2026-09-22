import {
	defaultShouldDehydrateQuery,
	MutationCache,
	QueryClient,
} from "@tanstack/react-query";

/**
 * Cache key of the capability-gate matrix (Fizzy #1930).
 *
 * Kept here rather than imported from the projects module so this file stays
 * free of feature imports; `useCapabilityGates` builds the same prefix.
 */
const CAPABILITY_GATES_QUERY_PREFIX = "capability-gates";

export function createQueryClient() {
	const queryClient: QueryClient = new QueryClient({
		/**
		 * Refresh capability gates after ANY successful mutation.
		 *
		 * A gate is derived from live project state — documents, contexts, the
		 * project brief, the codebase connection, scan configuration and job
		 * status — so almost any mutation on a project can change one. The query
		 * lives in a provider mounted on the project layout, which no mutation
		 * remounts, so without this the banner and every disabled action keep
		 * answering from the state the page loaded with.
		 *
		 * This is deliberately central rather than a call in each mutation. The
		 * first fix for this did it per-mutation, wiring only the scan
		 * configuration save, and the very next thing tried — deleting a
		 * project's documents — reproduced the same staleness because it was a
		 * different mutation. Enumerating the ones that matter is a list that
		 * rots the moment someone adds another; asking every mutation to
		 * remember a feature it has never heard of is worse.
		 *
		 * The cost is bounded: `invalidateQueries` only refetches ACTIVE
		 * queries, and this one is active only while a project page is open, so
		 * a mutation made anywhere else refetches nothing.
		 */
		mutationCache: new MutationCache({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: [CAPABILITY_GATES_QUERY_PREFIX],
				});
			},
			/**
			 * And after a refusal at a door. A 412 is the one moment the screen
			 * is provably stale — the page offered an action the server just
			 * said cannot run — so the gates are re-read to show why.
			 */
			onError: (error) => {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "PRECONDITION_FAILED"
				) {
					queryClient.invalidateQueries({
						queryKey: [CAPABILITY_GATES_QUERY_PREFIX],
					});
				}
			},
		}),
		defaultOptions: {
			queries: {
				staleTime: 60 * 1000,
				retry: false,
			},
			dehydrate: {
				// Only dehydrate successful queries. We previously also
				// dehydrated pending ones (the streaming-SSR pattern), but
				// any prefetch that errored mid-flight would surface on the
				// client as "A query that was dehydrated as pending ended
				// up rejecting" — including the expected FORBIDDEN responses
				// from billing prefetches for non-admin members. Server-side
				// prefetches in this app are all awaited before render
				// returns, so they're never in pending state at dehydrate
				// time on the happy path; nothing is lost by dropping the
				// pending clause.
				shouldDehydrateQuery: (query) =>
					query.state.status !== "error" &&
					defaultShouldDehydrateQuery(query),
			},
		},
	});
	return queryClient;
}

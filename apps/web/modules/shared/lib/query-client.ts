import {
	defaultShouldDehydrateQuery,
	QueryClient,
} from "@tanstack/react-query";

export function createQueryClient() {
	return new QueryClient({
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
}

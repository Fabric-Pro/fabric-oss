/**
 * How fresh each kind of Coding Instructions read must be. Every query in the
 * tab spreads one of these instead of choosing its own `staleTime`,
 * `refetchOnMount`, `refetchInterval` and `refetchOnWindowFocus`, so a read's
 * freshness is a named decision and not a combination of knobs.
 */

const REPOSITORY_STATE_POLL_MS = 60_000;

export const instructionsFreshness = {
	/**
	 * The branch head the provider reports. A push made outside Fabric shows
	 * up without More > Refresh: it polls once a minute, only while the tab is
	 * visible, and again when the window regains focus.
	 */
	liveRepositoryState: {
		refetchOnWindowFocus: true,
		refetchInterval: REPOSITORY_STATE_POLL_MS,
		refetchIntervalInBackground: false,
	},
	/**
	 * A read addressed by an immutable commit (files, file bodies, commits at
	 * a sha): the answer for a given key never changes, so it is fetched once.
	 */
	pinnedRead: {
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	},
	/**
	 * Suggestions and proposal branches. Always stale, so mounting or opening
	 * the dialog shows the current state; the caller adds its own
	 * `refetchInterval` for rows still in flight.
	 */
	proposalView: {
		staleTime: 0,
	},
	/** Settings that change only when this person changes them. */
	configurationRead: {
		refetchOnWindowFocus: false,
	},
} as const;

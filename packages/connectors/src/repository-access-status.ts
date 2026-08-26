/**
 * Map a repository access outcome to the integration status the badge shows.
 *
 * Pure and side-effect-free so the mapping is unit-testable without a network
 * or a database. Lives beside `verifyRepositoryAccess` because both consumers
 * — the OAuth connect callbacks (API layer) and the scheduled health check
 * (Temporal worker) — must agree on what a probe result MEANS, and this is the
 * package both already import the probe from. One mapping, or the two lanes
 * drift back into answering different questions with the same column. Kept
 * dependency-free (string-literal types only) deliberately: a workspace
 * dependency edge from here is one every agent Dockerfile would have to COPY.
 *
 * The distinction that matters: TOKEN_EXPIRED says "reconnect", which is right
 * ONLY when the credential itself was rejected. A credential the provider
 * authenticated but refused the repository (403), or one the repository is
 * invisible to (404), gets REPO_UNAVAILABLE — reconnecting refreshes the wrong
 * grant there; installing the app on the repository or re-adding with a PAT is
 * the actual remedy, so the stored lastError names it.
 *
 * An unreachable outcome is deliberately NOT a verdict: inconclusive ≠ cannot-
 * read, so today's behaviour stands (ACTIVE) and the next sweep re-classifies.
 */

import type { RepoAccessOutcome } from "./repository-access";

export interface RepoAccessVerdict {
	status: "ACTIVE" | "TOKEN_EXPIRED" | "REPO_UNAVAILABLE";
	lastError: string | null;
}

const PROVIDER_LABEL = {
	GITHUB: "GitHub",
	GITLAB: "GitLab",
	AZURE_DEVOPS: "Azure DevOps",
} as const;

/**
 * The exact verdict shape per outcome, resolved at the call site: a caller
 * holding a FAILURE outcome (`unauthorized` / `forbidden` / `not-found`) gets
 * a non-ACTIVE status and an always-present sentence, while
 * `accessible` / `unreachable` always mean ACTIVE with no error. Narrowing the
 * outcome therefore narrows what the caller can do with the verdict.
 */
export type RepoAccessVerdictFor<O extends RepoAccessOutcome> = O extends
	| "unauthorized"
	| "forbidden"
	| "not-found"
	? { status: "TOKEN_EXPIRED" | "REPO_UNAVAILABLE"; lastError: string }
	: { status: "ACTIVE"; lastError: null };

function repoAccessVerdict(
	outcome: RepoAccessOutcome,
	provider: keyof typeof PROVIDER_LABEL,
): RepoAccessVerdict {
	switch (outcome) {
		case "accessible":
		case "unreachable":
			return { status: "ACTIVE", lastError: null };
		case "unauthorized":
			return {
				status: "TOKEN_EXPIRED",
				// Naming the status keeps this line diagnostic — the hint above it
				// already says what to do.
				lastError: `${PROVIDER_LABEL[provider]} rejected the connected credentials (HTTP 401) as invalid or expired — reconnect the repository.`,
			};
		case "forbidden":
			// Cause only: wherever this surfaces (row, notification), the STATUS
			// already carries the remedy — printing it twice on one row is
			// noise, not help.
			return {
				status: "REPO_UNAVAILABLE",
				lastError: `${PROVIDER_LABEL[provider]} authenticated the credentials but refused this repository — the app may not be installed on it, or the token lacks read access.`,
			};
		case "not-found":
			return {
				status: "REPO_UNAVAILABLE",
				lastError: `${PROVIDER_LABEL[provider]} reports this repository as not found or not visible to the connected credentials (both answer 404) — check the URL.`,
			};
		default: {
			// Exhaustiveness guard: a new RepoAccessOutcome must be mapped
			// explicitly rather than silently inheriting a verdict.
			const exhaustive: never = outcome;
			return { status: "ACTIVE", lastError: String(exhaustive) };
		}
	}
}

export function integrationStatusForRepoAccess<O extends RepoAccessOutcome>(
	outcome: O,
	provider: keyof typeof PROVIDER_LABEL,
): RepoAccessVerdictFor<O> {
	// Single bridge between the per-outcome conditional type and the one plain
	// implementation above. Sound by construction: RepoAccessVerdictFor is
	// distributive over O, so every instantiation is backed by a matching arm
	// of `repoAccessVerdict` — the cast only restates what the conditional
	// already promises.
	return repoAccessVerdict(outcome, provider) as RepoAccessVerdictFor<O>;
}

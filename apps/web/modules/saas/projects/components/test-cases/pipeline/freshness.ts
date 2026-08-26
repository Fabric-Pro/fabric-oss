/**
 * What the runs panel says about how fresh its data is.
 *
 * The requirement is that a failing sync shows a stale-data indicator INCLUDING
 * the timestamp of the last successful fetch. The panel used to render the
 * failure *instead of* the freshness line, which hid the one fact that says
 * whether the runs on screen are twenty minutes or twenty days old — exactly
 * when it matters most. `lastFetchedAt` deliberately survives a failed sync
 * (only a success advances it), so the data was always there and simply unused.
 *
 * Pure, so the combinations are unit-testable without rendering the panel.
 */

/**
 * The single source of truth for what a classified sync-failure kind MEANS —
 * whose fault it is and whether reconnecting the repository fixes it.
 *
 * Imported from `@repo/utils`, not `@repo/temporal`: the kind→meaning table is
 * shared vocabulary between the Temporal worker that classifies the failure
 * and this `"use client"` bundle, and `apps/web` does not depend on
 * `@repo/temporal` for runtime values (see `BacklogChat.tsx`'s module doc for
 * the same rule and the same remedy — collapse both sides onto a shared
 * `@repo/utils` constant).
 */
import { classificationForRawKind } from "@repo/utils/pipeline-sync-failure-kinds";
import { syncProviderSupportsReconnect } from "@saas/projects/lib/repo-reconnect-capability";

/**
 * Two independent conditions, both required before the banner offers a
 * reconnect CTA: reconnecting has to FIX this kind of failure, and reconnect
 * has to EXIST for this provider. `classificationForRawKind` answers only the
 * first — it is provider-agnostic — so an Azure DevOps PAT failure classified
 * CREDENTIAL_REJECTED would otherwise get a "Reconnect" call-to-action linking
 * to a settings page that has no Azure DevOps reconnect action on it. The
 * provider half is the same gate `ProjectRepositoryIntegrationSettings.tsx`
 * applies to its own inline button, imported rather than restated.
 */
function reconnectFixes(
	kind: string | null | undefined,
	providerTag: string | null | undefined,
): boolean {
	return (
		(classificationForRawKind(kind)?.reconnectFixes ?? false) &&
		syncProviderSupportsReconnect(providerTag)
	);
}

type FreshnessTone = "error" | "warning";

export interface FreshnessView {
	/** Set when at least one source failed; drives the warning icon + tone. */
	failure?: {
		tone: FreshnessTone;
		/** True when EVERY source failed, not just some. */
		total: boolean;
		failedCount: number;
		sourceCount: number;
		/** The readable sentence — safe to render as the banner's body. */
		error: string;
		/**
		 * The provider's own words, revealed on demand rather than shown inline.
		 * Null when the failure was ours and there is no provider body to show.
		 */
		errorDetail: string | null;
		/** Which source failed, so a multi-repo project knows WHICH repo broke. */
		sourceLabel: string | null;
		/**
		 * True only when reconnecting the repository integration actually fixes
		 * this failure AND reconnect exists for this provider — drives whether
		 * the banner offers a reconnect link at all. A missing-permission or SSO
		 * failure showing a reconnect button would send someone through an OAuth
		 * round trip that fixes nothing; an Azure DevOps failure showing one
		 * would link to a page with no reconnect action at all.
		 */
		reconnectFixes: boolean;
	};
	/** Set whenever a successful fetch has ever happened — even alongside a failure. */
	lastFetchedAt?: Date;
	/** Only when nothing has ever synced AND nothing failed. */
	neverSynced: boolean;
}

export interface FreshnessInput {
	failedSources: Array<{
		lastError?: string | null;
		lastErrorDetail?: string | null;
		/** The classified failure kind — a `SyncFailureKind` from `@repo/temporal`. */
		lastErrorKind?: string | null;
		provider?: string | null;
		pipelineKey?: string | null;
	}>;
	sourceCount: number;
	lastFetchedAt?: Date | null;
}

export function describeFreshness(input: FreshnessInput): FreshnessView {
	const [firstFailure] = input.failedSources;
	const lastFetchedAt = input.lastFetchedAt ?? undefined;

	if (!firstFailure) {
		return { lastFetchedAt, neverSynced: !lastFetchedAt };
	}

	const total = input.failedSources.length >= input.sourceCount;
	return {
		failure: {
			tone: total ? "error" : "warning",
			total,
			failedCount: input.failedSources.length,
			sourceCount: input.sourceCount,
			error: firstFailure.lastError ?? "",
			errorDetail: firstFailure.lastErrorDetail ?? null,
			// `pipelineKey` is "owner/repo" for the repo-backed providers and ""
			// for a provider-wide source, so it is the most specific label
			// available without another query — and naming the repo is the point
			// when several are connected and only one is broken.
			sourceLabel:
				firstFailure.pipelineKey || firstFailure.provider || null,
			reconnectFixes: reconnectFixes(
				firstFailure.lastErrorKind,
				firstFailure.provider,
			),
		},
		// Reported alongside the failure, never replaced by it.
		lastFetchedAt,
		// A failure is itself a sync attempt, so "never synced" would be noise.
		neverSynced: false,
	};
}

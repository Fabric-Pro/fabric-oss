"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
	type GlossyEdition,
	glossyEditionQueryKey,
	isGlossyAccessDenied,
} from "./use-glossy-edition";

/**
 * Glossy entry points of a Proposal in artifact mode (Fizzy #2801).
 *
 * With the `PROPOSAL_ARTIFACT` rollout gate on, a Proposal is written
 * client-ready in one run and needs no Glossy edition, so its Glossy entry
 * points — the Download menu item and the tour anchor on its card, the Glossy
 * version link in its editor — are withheld. A Proposal that already has a
 * published legacy edition keeps them, so that edition stays reachable.
 * Business Case and every other type are untouched, and so is everything with
 * the gate off.
 *
 * "Published" means the edition has content to show. An edition row whose
 * first build never finished has nothing to open, and `projects.glossy.get`
 * refusing (NOT_FOUND with `GLOSSY_EDITION` off, or no access) is an answer
 * too: no entry point.
 */

/** Whether a document's Glossy entry depends on a published legacy edition. */
export function needsLegacyGlossyEdition(
	documentType: string | null | undefined,
	proposalArtifactEnabled: boolean,
): boolean {
	return proposalArtifactEnabled && documentType === "PROPOSAL";
}

/** Whether an edition read found published content. */
function hasPublishedGlossyEdition(read: GlossyEdition | undefined): boolean {
	return read?.edition?.content != null;
}

/**
 * How long an existence answer is reused before it is asked again. The read
 * signs every image the edition holds, and the list and each card's menu ask
 * the same question; the Glossy page keeps its own, fresher, polling.
 */
const LEGACY_EDITION_STALE_MS = 5 * 60 * 1000;

/**
 * The edition read as an existence check. Same key as `useGlossyEdition`, so
 * the Glossy page, the list and the editor share one cached answer; unlike
 * it, never polls a running build — whether an edition was published does
 * not change while a page is open.
 */
function legacyGlossyEditionQuery(
	projectId: string,
	documentId: string,
	enabled: boolean,
) {
	return {
		queryKey: glossyEditionQueryKey(projectId, documentId),
		queryFn: () =>
			orpcClient.projects.glossy.get({ projectId, documentId }),
		enabled,
		staleTime: LEGACY_EDITION_STALE_MS,
		refetchInterval: false as const,
		retry: (failureCount: number, error: unknown) =>
			!isGlossyAccessDenied(error) && failureCount < 2,
	};
}

/**
 * Whether one document has a published legacy Glossy edition: `true` or
 * `false` once known, `undefined` while unknown or not asked. Reads nothing
 * unless `enabled` — pass `needsLegacyGlossyEdition(...)` (and the
 * `GLOSSY_EDITION` gate, without which there is no entry to keep).
 */
export function useLegacyGlossyEdition(
	projectId: string,
	documentId: string,
	enabled: boolean,
): boolean | undefined {
	const query = useQuery(
		legacyGlossyEditionQuery(projectId, documentId, enabled),
	);
	if (!enabled) {
		return undefined;
	}
	if (query.isError) {
		return false;
	}
	return query.isSuccess ? hasPublishedGlossyEdition(query.data) : undefined;
}

/**
 * The documents among `documentIds` with a published legacy Glossy edition,
 * for a list: one read per document, shared with `useLegacyGlossyEdition`
 * through the query cache. A document still being read is not in the set, so
 * an entry point appears once its edition is confirmed rather than flashing
 * and then disappearing.
 */
export function useLegacyGlossyEditions(
	projectId: string,
	documentIds: readonly string[],
): ReadonlySet<string> {
	const results = useQueries({
		queries: documentIds.map((documentId) =>
			legacyGlossyEditionQuery(projectId, documentId, true),
		),
	});
	return new Set(
		documentIds.filter((_, index) => {
			const result = results[index];
			return (
				result?.isSuccess === true &&
				hasPublishedGlossyEdition(result.data)
			);
		}),
	);
}

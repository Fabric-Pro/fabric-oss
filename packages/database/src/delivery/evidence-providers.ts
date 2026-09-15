/**
 * Readiness evidence providers (plan §1.1, Slices 3 and 4).
 *
 * `evaluateReadiness` asks two questions it cannot answer from the story row:
 *   - SPIKE:     has at least one Spike run on this story been ACCEPTED?
 *   - DISCOVERY: is there a COMPLETE INTEGRATION_CONTRACT document for it?
 *
 * Both are answered here from the database inside the caller's transaction,
 * so the gate and the write see the same snapshot. Any lookup error marks
 * evidence unavailable, which the policy treats as not ready (fail closed).
 */

import type { DbClient } from "./transition-story";
import { registerReadinessEvidenceProvider } from "./transition-story";

/**
 * What "an accepted spike run" is, as a CodingRun filter. Shared with the
 * estimate / track procedures so their conditional writes (`codingRuns:
 * { some | none: ... }`) and this count can never disagree.
 */
export const ACCEPTED_SPIKE_RUN_WHERE = {
	kind: "SPIKE",
	status: "COMPLETED",
	findings: { not: null },
} as const;

export async function countAcceptedSpikeRuns(
	client: DbClient,
	params: { storyId: string; projectId: string },
): Promise<number> {
	return await client.codingRun.count({
		where: {
			storyId: params.storyId,
			projectId: params.projectId,
			...ACCEPTED_SPIKE_RUN_WHERE,
		},
	});
}

export async function hasCompleteIntegrationContract(
	client: DbClient,
	params: { storyId: string; projectId: string },
): Promise<boolean> {
	const doc = await client.projectDocument.findFirst({
		where: {
			storyId: params.storyId,
			projectId: params.projectId,
			type: "INTEGRATION_CONTRACT",
			status: "COMPLETE",
			isActive: true,
		},
		select: { id: true },
	});
	return doc !== null;
}

let registered = false;

/** Idempotent: registers both providers once per process. */
export function registerDefaultEvidenceProviders(): void {
	if (registered) return;
	registered = true;
	registerReadinessEvidenceProvider(async (client, params) => ({
		acceptedSpikeRuns: await countAcceptedSpikeRuns(client, params),
	}));
	registerReadinessEvidenceProvider(async (client, params) => ({
		integrationContractComplete: await hasCompleteIntegrationContract(
			client,
			params,
		),
	}));
}

/** Test hook. */
export function _resetDefaultEvidenceProviderRegistration(): void {
	registered = false;
}

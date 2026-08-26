/**
 * MANUAL accept flow (Feature Maturation V2, §7.5). When the Clean Spec tab is in
 * MANUAL approval mode, TG4 propagation stashes the proposed `{from,to}` patch
 * set as PENDING on the decision's `metadata.cleanSpecPropagation.pendingPatches`
 * instead of writing the spec. This module applies that stashed set on the PO's
 * explicit accept: re-locate the patches against the CURRENT Clean Spec (the doc
 * may have moved since), write + version via the shared helper, and clear the
 * pending set off the decision.
 *
 * Safety mirrors TG4: any patch that can't be located verbatim refuses the WHOLE
 * set (the spec is left byte-identical) — a stale pending set is surfaced, never
 * silently half-applied.
 */

import {
	type DecisionLogEntry,
	type FeatureMaturationState,
	type MaturationTenantFilter,
	setDecisionMetadata,
} from "@repo/database";
import {
	combineCleanSpec,
	splitCleanSpec,
} from "@repo/utils/clean-spec-content";
import { writeCleanSpecWithVersion } from "./clean-spec-write";
import {
	applySpecPatches,
	type PatchFailure,
	type SpecPatch,
} from "./spec-patch";

type AcceptStatus = "applied" | "refused" | "noop";

export interface AcceptOutcome {
	status: AcceptStatus;
	applied: SpecPatch[];
	failed: PatchFailure[];
	pmSyncEnqueued: boolean;
}

export interface AcceptPendingPatchesParams {
	feature: FeatureMaturationState;
	decision: DecisionLogEntry;
	tenantFilter: MaturationTenantFilter;
	projectId: string;
	lastEditedByName?: string | null;
}

function readMetadataObject(
	metadata: DecisionLogEntry["metadata"],
): Record<string, unknown> {
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: {};
}

/** Pull the stashed PENDING patch set off a decision's metadata, if present. */
export function readPendingPatches(decision: DecisionLogEntry): SpecPatch[] {
	const propagation = readMetadataObject(decision.metadata)
		.cleanSpecPropagation as Record<string, unknown> | undefined;
	const pending = propagation?.pendingPatches;
	if (!Array.isArray(pending)) {
		return [];
	}
	return pending.filter(
		(p): p is SpecPatch =>
			!!p &&
			typeof p === "object" &&
			typeof (p as SpecPatch).from === "string" &&
			typeof (p as SpecPatch).to === "string",
	);
}

function summarize(patches: SpecPatch[]): string {
	const text = patches.map((p) => p.summary).join("; ");
	return text.length > 280
		? `${text.slice(0, 277)}...`
		: text || "spec update";
}

/**
 * Apply a decision's PENDING patches to the Clean Spec on explicit accept, then
 * clear them off the decision. Throws only on model/DB failure; the caller wraps
 * it. A refusal (patch no longer locates) is a returned outcome, not a throw.
 */
export async function acceptPendingPatches({
	feature,
	decision,
	tenantFilter,
	projectId,
	lastEditedByName,
}: AcceptPendingPatchesParams): Promise<AcceptOutcome> {
	const pending = readPendingPatches(decision);
	if (pending.length === 0) {
		return {
			status: "noop",
			applied: [],
			failed: [],
			pmSyncEnqueued: false,
		};
	}

	const spec = combineCleanSpec(
		feature.description,
		feature.acceptanceCriteria,
	);
	const { result, applied, failed } = applySpecPatches(spec, pending);

	const base = readMetadataObject(decision.metadata);

	// Stale pending set — at least one patch no longer locates. Refuse the whole
	// set, leave the spec untouched, and record the failure on the decision.
	if (failed.length > 0) {
		await setDecisionMetadata({
			tenantFilter,
			id: decision.id,
			metadata: {
				...base,
				cleanSpecPropagation: {
					status: "refused",
					acceptedAt: new Date().toISOString(),
					failures: failed.map((f) => ({
						reason: f.reason,
						matchCount: f.matchCount,
						from: f.patch.from.slice(0, 200),
					})),
				},
			},
		});
		return {
			status: "refused",
			applied: [],
			failed,
			pmSyncEnqueued: false,
		};
	}

	const split = splitCleanSpec(result);
	const { pmSyncEnqueued } = await writeCleanSpecWithVersion({
		projectId,
		storyId: feature.id,
		tenantFilter,
		newDescription: split.description,
		newAcceptanceCriteria: split.acceptanceCriteria,
		changeSummary: summarize(applied),
		lastEditedByName,
	});

	// Applied — clear the pending set so the Clean Spec tab drops the review banner.
	await setDecisionMetadata({
		tenantFilter,
		id: decision.id,
		metadata: {
			...base,
			cleanSpecPropagation: {
				status: "applied",
				acceptedAt: new Date().toISOString(),
				appliedSummaries: applied.map((p) => p.summary),
				pendingPatches: [],
				failures: [],
				pmSyncEnqueued,
			},
		},
	});

	return { status: "applied", applied, failed: [], pmSyncEnqueued };
}

/**
 * The spec §5.4 outcome table as one pure function (design 2026-09-23).
 * Durable snapshot state decides; the child's `publishReason` only names a
 * refusal. Not re-exported from the activities barrel.
 */
import type {
	InstructionSyncRunStatus,
	InstructionSyncSchedulingEffect,
} from "@repo/database";
import type {
	InstructionSyncErrorCode,
	InstructionSyncTrigger,
} from "../../lib/instruction-sync-types";

export type SyncSnapshotState = {
	status: "RECEIVING" | "VALIDATING" | "READY" | "REJECTED" | "FAILED";
	publishedAt: Date | null;
	rejection: unknown;
	isPublishedPointer: boolean;
};

export type SyncOutcomeInput = {
	trigger: InstructionSyncTrigger;
	skipped: boolean;
	unchanged: boolean;
	/** The acquisition's (or begin's) typed failure, if any. */
	error: InstructionSyncErrorCode | null;
	commitSha: string | null;
	snapshot: SyncSnapshotState | null;
	publishReason: string | null;
};

type SyncOutcome = {
	status: InstructionSyncRunStatus;
	error: InstructionSyncErrorCode | null;
	note: "superseded" | null;
	scheduling: InstructionSyncSchedulingEffect;
};

/** The reaper's (and Part A's) `abandoned` verdict, pending or swept. */
function hasAbandonedMarker(rejection: unknown): boolean {
	return (
		Array.isArray(rejection) &&
		rejection.some(
			(r) =>
				r !== null &&
				typeof r === "object" &&
				(r as { reason?: unknown }).reason === "abandoned",
		)
	);
}

export function deriveSyncRunOutcome(input: SyncOutcomeInput): SyncOutcome {
	const none = { kind: "none" } as const;
	const backoff = { kind: "backoff" } as const;
	const success = { kind: "success", commitSha: input.commitSha } as const;
	// Suppressing needs a commit to key on; without one, back off instead.
	const suppress = input.commitSha
		? ({ kind: "suppress", commitSha: input.commitSha } as const)
		: backoff;
	const revoked =
		input.trigger === "MANUAL"
			? none
			: ({ kind: "pause", reason: "PERMISSION_REVOKED" } as const);
	const result = (
		status: InstructionSyncRunStatus,
		error: InstructionSyncErrorCode | null,
		scheduling: InstructionSyncSchedulingEffect,
		note: "superseded" | null = null,
	): SyncOutcome => ({ status, error, note, scheduling });

	if (input.skipped) {
		return result("SKIPPED", null, none);
	}
	const snapshot = input.snapshot;
	if (snapshot) {
		if (snapshot.isPublishedPointer) {
			return result("SUCCEEDED", null, success);
		}
		if (snapshot.status === "READY" && snapshot.publishedAt !== null) {
			return result("SUCCEEDED", null, success, "superseded");
		}
		if (snapshot.status === "READY") {
			switch (input.publishReason) {
				case "configuration_changed":
					return result(
						"NOT_PUBLISHED",
						"CONFIGURATION_CHANGED",
						none,
					);
				case "older_than_current":
					return result("NOT_PUBLISHED", null, none);
				case "permission_revoked":
					return result(
						"NOT_PUBLISHED",
						"PERMISSION_DENIED",
						revoked,
					);
				default:
					return result("FAILED", "CHILD_ABORTED", backoff);
			}
		}
		if (
			snapshot.status === "REJECTED" &&
			!hasAbandonedMarker(snapshot.rejection)
		) {
			return result("REJECTED", null, suppress);
		}
		// Abandoned, FAILED, or still RECEIVING/VALIDATING when the run ends.
		return result("FAILED", input.error ?? "CHILD_ABORTED", backoff);
	}
	if (input.unchanged) {
		return result("UNCHANGED", null, success);
	}
	switch (input.error) {
		case "LIMITS_EXCEEDED":
		case "TREE_REFUSED":
			return result("FAILED", input.error, suppress);
		case "PERMISSION_DENIED":
			return result("FAILED", input.error, revoked);
		case "REF_MISSING":
		case "ROOT_MISSING":
			return result("FAILED", input.error, {
				kind: "pause",
				reason: "REF_MISSING",
			});
		case "CONFIGURATION_CHANGED":
			return result("FAILED", input.error, none);
		default:
			return result("FAILED", input.error ?? "CLONE_FAILED", backoff);
	}
}

import type { InstructionRejection } from "@repo/database";
import type { ExcludedPath } from "@repo/instructions";

/**
 * `rejection` and `settingsFrozen` are read straight off a Prisma `Json`
 * column (see `ProjectInstructionSnapshot` in schema.prisma), so the oRPC
 * client infers them as generic JSON rather than their actual shape. This
 * type states the real shape the scan/validation activity writes; the
 * caller (`CodingInstructionsTab.tsx`) casts the raw query result into it
 * once, at the boundary, rather than every read site re-deriving it.
 */
export type InstructionsSnapshot = {
	id: string;
	version: number;
	status: string;
	source: string;
	/** A synced version's branch and commit, and the integration it came from. */
	sourceRef?: string | null;
	sourceCommitSha?: string | null;
	repositoryIntegrationId?: string | null;
	fileCount: number;
	excludedCount: number;
	/**
	 * The names behind `excludedCount`, up to 500, read from a `Json` column
	 * like `rejection`. Only the published read carries them, and a version made
	 * before the column existed holds an empty list beside a non-zero count.
	 */
	excludedPaths?: ExcludedPath[] | null;
	createdAt: string | Date;
	rejection?: InstructionRejection[] | null;
	user?: { id: string; name: string | null } | null;
	settingsFrozen?: { layer?: string } | null;
	/** Set when this version came from an in-tab edit rather than an upload. */
	baseSnapshotId?: string | null;
	/**
	 * The version this one was edited from. Unlike `baseSnapshotId`, which is
	 * `SetNull` in the database, this survives the base being deleted or
	 * pruned — so it, not the id, is what says a version is an edit at all.
	 */
	baseVersion?: number | null;
	/** Whether this version meant to publish itself when its checks passed. */
	publishOnReady?: boolean;
	/**
	 * When this version last held the published pointer, and null for one
	 * that never has. Nothing clears it, so it is the difference between an
	 * edit that never published and one that published and was then replaced
	 * — which is what the superseded line turns on.
	 */
	publishedAt?: string | Date | null;
	/**
	 * Proposal lifecycle is rendered in the proposal review dialog. A
	 * suggestion's pull request settles as MERGED or CLOSED (Fizzy #2563).
	 */
	proposalStatus?:
		| "PENDING"
		| "APPROVED"
		| "REJECTED"
		| "MERGED"
		| "CLOSED"
		| null;
	/**
	 * Where a proposal goes, and `REPOSITORY_COMMIT` for a direct commit to the
	 * synced branch (Fizzy #2878 §10): not a proposal, and not a version until
	 * the branch holds it. Its words differ (no upload, nothing synced yet).
	 */
	proposalDestination?: "FABRIC" | "REPOSITORY" | "REPOSITORY_COMMIT" | null;
	/**
	 * Publish first, scan afterwards (Fizzy #2737). `publishBeforeScan` is the
	 * member's opt-in; `deferredScanStatus` is null for every ordinary version
	 * and otherwise the scan's state, and `deferredScanFindings` carries its
	 * findings in the same shape as `rejection`.
	 */
	publishBeforeScan?: boolean;
	deferredScanStatus?:
		| "PENDING"
		| "PASSED"
		| "ISSUES_FOUND"
		| "INCOMPLETE"
		| null;
	deferredScanFindings?: InstructionRejection[] | null;
	/** When the version became readable; what a pending scan is dated from. */
	readyAt?: string | Date | null;
	/**
	 * How far the running checks have got (`recordInstructionSnapshotProgress`):
	 * the pass, and the files it has fully decided out of the files it has to
	 * decide. Null when nothing has reported yet, and for runs that started
	 * before progress existed.
	 */
	progressPhase?: "CHECKING" | "SAVING" | "SCANNING" | null;
	progressDone?: number | null;
	progressTotal?: number | null;
};

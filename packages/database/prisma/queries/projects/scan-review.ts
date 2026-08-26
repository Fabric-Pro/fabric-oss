/**
 * Database queries for the on-demand AI false-positive REVIEW of scan findings
 * (G7 of the Security & Accessibility Scanning enhancements).
 *
 * A `ScanFindingReview` is a single review run: an adversarial, fresh-context AI
 * judge re-examines the project's current OPEN findings and PROPOSES dismiss /
 * severity-change / uncertain verdicts. Proposals never mutate findings — the
 * user confirms which to apply in a separate step.
 *
 * Tenant isolation mirrors `scan.ts`: callers (oRPC procedures) gate access via
 * `hasProjectAccess` + permission middleware; every write carries
 * userId/organizationId so the `user_owned` RLS policy and the app-layer XOR
 * filter both hold.
 */

import { db, type Prisma } from "../../client";
import type {
	ScanCategory,
	ScanFindingStatus,
	ScanSeverity,
	ScanStatus,
} from "../../generated/client";

// =============================================================================
// Types
// =============================================================================

/**
 * One proposal the judge produced for a single finding. Persisted as an element
 * of `ScanFindingReview.proposals` (JSON). `suggestedStatus` is "DISMISSED" only
 * when `verdict === "false_positive"`; a `confirmed`/`uncertain` verdict leaves
 * the finding's status untouched. All free-text fields are redacted before they
 * reach this shape (defense-in-depth — see review-schemas.ts).
 */
export type ScanReviewProposal = {
	findingId: string;
	verdict: "confirmed" | "false_positive" | "uncertain";
	/** Suggested status change (DISMISSED on a false positive); else absent. */
	suggestedStatus?: ScanFindingStatus;
	/** Suggested severity re-grade (normalized); absent when unchanged/unknown. */
	suggestedSeverity?: ScanSeverity;
	reasoning: string;
	/** Categorical confidence in the verdict ("high" | "medium" | "low"). */
	confidence: string;
	/** Short exact quote from the evidence that anchors the verdict. */
	evidenceQuote?: string;
};

/**
 * A current OPEN finding projected into the minimal shape the judge needs. Only
 * the fields that ground an adversarial re-examination are included (no scan
 * internals, no carry-forward bookkeeping).
 */
export type FindingForReview = {
	id: string;
	category: ScanCategory;
	severity: ScanSeverity;
	title: string;
	description: string;
	ruleSource: string;
	location: string | null;
	sourceUrl: string | null;
	/** 0..1 derived confidence from the originating scan; null for legacy rows. */
	confidence: number | null;
	/** Redacted source excerpt grounding the finding; null when none was captured. */
	evidence: string | null;
};

// =============================================================================
// Review runs
// =============================================================================

/**
 * Create a `ScanFindingReview` row in PENDING. Tenant fields are required for
 * RLS / XOR. The workflow then drives it RUNNING → COMPLETED / FAILED.
 */
export async function createScanFindingReview(data: {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	workflowId?: string | null;
}) {
	return db.scanFindingReview.create({
		data: {
			projectId: data.projectId,
			status: "PENDING",
			workflowId: data.workflowId ?? null,
			userId: data.userId,
			organizationId: data.organizationId ?? null,
		},
	});
}

/** A review run by id, scoped to its project for tenant safety. */
export async function getScanFindingReview(
	reviewId: string,
	projectId: string,
) {
	return db.scanFindingReview.findFirst({
		where: { id: reviewId, projectId },
	});
}

/**
 * The most-recent review run for a project (drives the page's "review findings"
 * status + polling). Optionally scoped to a status. Null ⇒ never reviewed.
 */
export async function getLatestScanFindingReview(
	projectId: string,
	opts: { status?: ScanStatus } = {},
) {
	return db.scanFindingReview.findFirst({
		where: {
			projectId,
			...(opts.status ? { status: opts.status } : {}),
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Patch a review run. Only the provided fields are written, so the workflow can
 * advance it incrementally (mark RUNNING with startedAt; persist proposals +
 * telemetry + COMPLETED; or FAILED with an error). Scoped by `projectId` is the
 * caller's responsibility at the procedure layer; the workflow holds the id.
 */
export async function updateScanFindingReview(
	reviewId: string,
	data: {
		status?: ScanStatus;
		proposals?: ScanReviewProposal[];
		reviewedCount?: number;
		modelName?: string | null;
		inputTokens?: number | null;
		outputTokens?: number | null;
		costUsd?: number | null;
		durationMs?: number | null;
		error?: string | null;
		workflowId?: string | null;
		startedAt?: Date | null;
		completedAt?: Date | null;
	},
) {
	const patch: Prisma.ScanFindingReviewUpdateInput = {};
	if (data.status !== undefined) {
		patch.status = data.status;
	}
	if (data.proposals !== undefined) {
		// Stored as JSON; the typed array is structurally JSON-safe.
		patch.proposals = data.proposals as unknown as Prisma.InputJsonValue;
	}
	if (data.reviewedCount !== undefined) {
		patch.reviewedCount = data.reviewedCount;
	}
	if (data.modelName !== undefined) {
		patch.modelName = data.modelName;
	}
	if (data.inputTokens !== undefined) {
		patch.inputTokens = data.inputTokens;
	}
	if (data.outputTokens !== undefined) {
		patch.outputTokens = data.outputTokens;
	}
	if (data.costUsd !== undefined) {
		patch.costUsd = data.costUsd;
	}
	if (data.durationMs !== undefined) {
		patch.durationMs = data.durationMs;
	}
	if (data.error !== undefined) {
		patch.error = data.error;
	}
	if (data.workflowId !== undefined) {
		patch.workflowId = data.workflowId;
	}
	if (data.startedAt !== undefined) {
		patch.startedAt = data.startedAt;
	}
	if (data.completedAt !== undefined) {
		patch.completedAt = data.completedAt;
	}
	return db.scanFindingReview.update({
		where: { id: reviewId },
		data: patch,
	});
}

/**
 * Is there already a non-terminal review for this project? Used to dedupe the
 * "Review findings" trigger so a double-click / concurrent request can't spawn a
 * pile of redundant review runs (mirrors `hasActiveScan`).
 */
export async function hasActiveScanReview(projectId: string): Promise<boolean> {
	const active = await db.scanFindingReview.findFirst({
		where: {
			projectId,
			status: { in: ["PENDING", "RUNNING"] },
		},
		select: { id: true },
	});
	return active !== null;
}

// =============================================================================
// Findings to review
// =============================================================================

/**
 * Load the project's current OPEN findings for an adversarial review, projected
 * to the minimal fields a judge needs. Scoped to the latest COMPLETED scan when
 * `scanId` is omitted (so a re-scan's superseded rows aren't re-judged); pass an
 * explicit `scanId` to pin a specific scan. Tenant-scoped by `projectId`
 * (callers gate access at the procedure layer).
 *
 * RESOLVED / DISMISSED findings are excluded — the judge only re-examines open
 * issues. Returns highest-severity first so a truncated batch favours impact.
 */
export async function listOpenFindingsForReview(
	projectId: string,
	scanId?: string,
	opts: {
		/**
		 * Restrict to a confidence band — used by the AUTO review to judge only the
		 * ambiguous, visible band and skip the tails (already-hidden low-confidence
		 * + obviously-strong high-confidence), keeping the LLM spend small and
		 * targeted. Omitted ⇒ every OPEN finding (the on-demand review path).
		 */
		minConfidence?: number;
		maxConfidence?: number;
	} = {},
): Promise<FindingForReview[]> {
	// When no scan is pinned, default to the latest COMPLETED scan's findings so
	// the review matches what the user currently sees (a re-scan replaces the
	// displayed set rather than stacking on top of it).
	let resolvedScanId = scanId ?? null;
	if (!resolvedScanId) {
		const latest = await db.projectScan.findFirst({
			where: { projectId, status: "COMPLETED" },
			orderBy: { createdAt: "desc" },
			select: { id: true },
		});
		resolvedScanId = latest?.id ?? null;
	}

	// A band clause is applied only when the caller asks for one (auto review).
	const confidenceClause =
		opts.minConfidence !== undefined || opts.maxConfidence !== undefined
			? {
					confidence: {
						...(opts.minConfidence !== undefined
							? { gte: opts.minConfidence }
							: {}),
						...(opts.maxConfidence !== undefined
							? { lt: opts.maxConfidence }
							: {}),
					},
				}
			: {};

	const findings = await db.scanFinding.findMany({
		where: {
			projectId,
			status: "OPEN",
			...(resolvedScanId ? { scanId: resolvedScanId } : {}),
			...confidenceClause,
		},
		select: {
			id: true,
			category: true,
			severity: true,
			title: true,
			description: true,
			ruleSource: true,
			location: true,
			sourceUrl: true,
			confidence: true,
			evidence: true,
		},
		orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
		// High ceiling so a large project is still fully reviewable; the activity
		// batches + bounds concurrency so this is not a per-call cost.
		take: 600,
	});

	return findings.map((f) => ({
		id: f.id,
		category: f.category,
		severity: f.severity,
		title: f.title,
		description: f.description,
		ruleSource: f.ruleSource,
		location: f.location,
		sourceUrl: f.sourceUrl ?? null,
		confidence: f.confidence ?? null,
		evidence: f.evidence ?? null,
	}));
}

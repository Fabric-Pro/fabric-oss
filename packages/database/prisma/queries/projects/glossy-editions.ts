/**
 * Glossy editions (Fizzy #2589) — the edition, its build attempts, review
 * decisions and the segment cache.
 *
 * A build is a CLAIMED ATTEMPT. The claim moves `GlossyEdition.currentBuildId`
 * to a freshly minted attempt id and inserts that attempt's `GlossyBuild` row
 * (status BUILDING, with the source snapshot) in one transaction. Every later
 * write by the run is guarded on that attempt id — never on a shared status, a
 * guard every rebuild would pass through
 * (docs/solutions/architecture-patterns/a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md)
 * — and returns `applied` or `superseded`, never a bare count, so a caller
 * never has to guess what a zero meant.
 *
 * Invariant the guards rely on: a `GlossyBuild` row is BUILDING exactly while
 * its edition's `currentBuildId` names it. The claim sets both; finalize, fail
 * and reclaim move both, each in one transaction. So a guard on
 * `status = BUILDING` of the attempt's own row is also a guard on
 * `currentBuildId = buildId`, and Postgres re-checks it against the newest row
 * version when a concurrent writer got there first.
 *
 * Lock order: a transaction that changes an existing attempt row and its
 * edition — finalize, fail, reclaim — locks the attempt row first and the
 * edition row second. One order, so no two of them deadlock; and a cache write
 * holding the attempt row FOR SHARE (`putCacheEntry`) either commits before
 * such a transaction changes anything or re-checks after it has committed.
 *
 * Tenant columns are never taken from the caller. The edition derives them
 * from the document's project, and every other row copies them from the
 * edition or the attempt. The Temporal worker bypasses RLS, so this is what
 * keeps its writes in the right tenant; RLS
 * (`project_member_or_tenant_consistent`) enforces the same for sessions.
 */

import { createId } from "@paralleldrive/cuid2";
import { db, type Prisma } from "../../client";

type Client = Prisma.TransactionClient | typeof db;

export const GLOSSY_BUILD_STATUSES = [
	"BUILDING",
	"SUCCEEDED",
	"FAILED",
	"SUPERSEDED",
] as const;
export type GlossyBuildStatus = (typeof GLOSSY_BUILD_STATUSES)[number];

export const GLOSSY_CACHE_KINDS = [
	"REWRITE",
	"DETECTION",
	"EXTRACTION",
] as const;
export type GlossyCacheKind = (typeof GLOSSY_CACHE_KINDS)[number];

export const GLOSSY_VISUAL_DECISIONS = ["ACCEPTED", "DISCARDED"] as const;
export type GlossyVisualDecisionValue =
	(typeof GLOSSY_VISUAL_DECISIONS)[number];

/** The answer of every attempt-guarded write. */
export type GlossyGuardedOutcome = "applied" | "superseded";

/** Error code a failed workflow start leaves on its attempt. */
export const GLOSSY_WORKFLOW_START_FAILED = "WORKFLOW_START_FAILED";

/** Longest error message persisted on an attempt. */
export const GLOSSY_ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * The Temporal workflow id for one attempt. Keyed on the attempt, so a rebuild
 * never collides with a previous run's id, and stored on the attempt at claim
 * time so a stale-holder check can describe the exact run.
 */
export function glossyEditionBuildWorkflowId(
	documentId: string,
	buildId: string,
): string {
	return `glossy-edition-build-${documentId}-${buildId}`;
}

/**
 * The document is missing, belongs to another project, or its project has no
 * organization. The build procedure's gate refuses all three first; reaching
 * this means the gate and the data disagree, so it fails closed.
 */
export class GlossyEditionTenantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GlossyEditionTenantError";
	}
}

/** A write found the attempt invariant broken; its transaction rolled back. */
export class GlossyBuildInvariantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GlossyBuildInvariantError";
	}
}

// ---------------------------------------------------------------------------
// Edition row
// ---------------------------------------------------------------------------

interface EditionTenant {
	id: string;
	projectId: string;
	organizationId: string;
}

async function ensureGlossyEditionWith(
	client: Client,
	input: { documentId: string; projectId: string; organizationId?: string },
): Promise<EditionTenant> {
	const document = await client.projectDocument.findFirst({
		where: { id: input.documentId, projectId: input.projectId },
		select: { project: { select: { organizationId: true } } },
	});
	const organizationId = document?.project.organizationId;
	if (!organizationId) {
		throw new GlossyEditionTenantError(
			"The document is not in an organization project",
		);
	}
	if (input.organizationId && input.organizationId !== organizationId) {
		throw new GlossyEditionTenantError(
			"The document belongs to another organization",
		);
	}
	// ON CONFLICT DO NOTHING: two first claims racing on a missing row both
	// get past this without a unique violation; the second waits for the
	// first's row and then leaves it alone.
	await client.glossyEdition.createMany({
		data: [
			{
				documentId: input.documentId,
				projectId: input.projectId,
				organizationId,
			},
		],
		skipDuplicates: true,
	});
	const edition = await client.glossyEdition.findUniqueOrThrow({
		where: { documentId: input.documentId },
		select: { id: true, projectId: true, organizationId: true },
	});
	if (
		edition.projectId !== input.projectId ||
		edition.organizationId !== organizationId
	) {
		throw new GlossyEditionTenantError(
			"The edition's tenant columns disagree with its document",
		);
	}
	return edition;
}

/**
 * Insert the edition row if it does not exist yet, and return it. Its tenant
 * columns come from the document's project; `organizationId`, when given, is
 * only checked against them.
 */
export async function ensureGlossyEdition(input: {
	documentId: string;
	projectId: string;
	organizationId?: string;
}): Promise<EditionTenant> {
	return ensureGlossyEditionWith(db, input);
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export interface GlossyBuildSnapshotInput {
	title: string;
	content: string;
	version: number;
	/** `computeDocumentContentHash` of `content`. */
	contentHash: string;
}

export interface ClaimGlossyBuildInput {
	documentId: string;
	projectId: string;
	/** The organization the gate resolved; checked, never written as given. */
	organizationId: string;
	startedById: string;
	options: Prisma.InputJsonValue;
	snapshot: GlossyBuildSnapshotInput;
	/**
	 * Take the claim over from a stale holder. Pass it only after Temporal has
	 * reported the holder's workflow closed or missing; the database adds the
	 * other half of the rule, that its heartbeat is older than `staleBefore`.
	 */
	reclaim?: { holderBuildId: string; staleBefore: Date };
	now?: Date;
}

export interface GlossyBuildHolder {
	buildId: string;
	startedById: string | null;
	startedAt: Date;
	heartbeatAt: Date | null;
	workflowId: string | null;
}

export type ClaimGlossyBuildResult =
	| {
			outcome: "claimed";
			buildId: string;
			editionId: string;
			organizationId: string;
			workflowId: string;
			startedAt: Date;
	  }
	| { outcome: "alreadyBuilding"; holder: GlossyBuildHolder | null };

/** Thrown inside a claim transaction to roll it back; never escapes. */
class ClaimLost extends Error {}

/** How often a claim re-reads a holder that finished between two statements. */
const CLAIM_ATTEMPTS = 3;

/**
 * Claim the edition for a new build attempt.
 *
 * In one transaction: insert the edition if absent, then one conditional
 * update that moves `currentBuildId` to a new attempt id — when no attempt
 * holds it, or, with `reclaim`, when the named holder's heartbeat is stale —
 * then insert the attempt row with the snapshot. Two concurrent claims
 * serialize on the edition row, so exactly one is `claimed` and the other
 * reads the winner as its holder.
 */
export async function claimGlossyBuild(
	input: ClaimGlossyBuildInput,
): Promise<ClaimGlossyBuildResult> {
	for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
		const claimed = await tryClaim(input);
		if (claimed) {
			return claimed;
		}
		const holder = await readHolder(input.documentId);
		if (holder) {
			return { outcome: "alreadyBuilding", holder };
		}
		// The holder finished between the conditional update and this read,
		// so the claim is free again: try once more.
	}
	return { outcome: "alreadyBuilding", holder: null };
}

async function tryClaim(
	input: ClaimGlossyBuildInput,
): Promise<Extract<ClaimGlossyBuildResult, { outcome: "claimed" }> | null> {
	const buildId = createId();
	const now = input.now ?? new Date();
	const workflowId = glossyEditionBuildWorkflowId(input.documentId, buildId);
	try {
		return await db.$transaction(async (tx) => {
			const edition = await ensureGlossyEditionWith(tx, input);

			let reclaimable = false;
			if (input.reclaim) {
				// Retire the stale holder first: attempt row before edition row,
				// the order finalize and fail lock in too. This locks its row, so
				// a late heartbeat from it either lands before (and keeps it
				// fresh, failing the reclaim) or re-checks after and finds it
				// retired.
				const retired = await tx.glossyBuild.updateMany({
					where: {
						id: input.reclaim.holderBuildId,
						documentId: input.documentId,
						status: "BUILDING",
						heartbeatAt: { lt: input.reclaim.staleBefore },
					},
					data: { status: "SUPERSEDED", finishedAt: now },
				});
				reclaimable = retired.count > 0;
			}

			const moved = await tx.glossyEdition.updateMany({
				where: {
					id: edition.id,
					OR: [
						{ currentBuildId: null },
						...(reclaimable && input.reclaim
							? [{ currentBuildId: input.reclaim.holderBuildId }]
							: []),
					],
				},
				data: { currentBuildId: buildId, lastOptions: input.options },
			});
			if (moved.count === 0) {
				// Also undoes a holder retirement above.
				throw new ClaimLost();
			}

			await tx.glossyBuild.create({
				data: {
					id: buildId,
					documentId: input.documentId,
					projectId: edition.projectId,
					organizationId: edition.organizationId,
					status: "BUILDING",
					startedById: input.startedById,
					startedAt: now,
					heartbeatAt: now,
					workflowId,
					options: input.options,
					sourceTitle: input.snapshot.title,
					sourceContent: input.snapshot.content,
					sourceVersion: input.snapshot.version,
					sourceContentHash: input.snapshot.contentHash,
				},
				select: { id: true },
			});

			return {
				outcome: "claimed" as const,
				buildId,
				editionId: edition.id,
				organizationId: edition.organizationId,
				workflowId,
				startedAt: now,
			};
		});
	} catch (error) {
		if (error instanceof ClaimLost) {
			return null;
		}
		throw error;
	}
}

async function readHolder(
	documentId: string,
): Promise<GlossyBuildHolder | null> {
	const edition = await db.glossyEdition.findUnique({
		where: { documentId },
		select: { currentBuildId: true },
	});
	if (!edition?.currentBuildId) {
		return null;
	}
	const build = await db.glossyBuild.findUnique({
		where: { id: edition.currentBuildId },
		select: {
			id: true,
			startedById: true,
			startedAt: true,
			heartbeatAt: true,
			workflowId: true,
		},
	});
	if (!build) {
		return null;
	}
	return {
		buildId: build.id,
		startedById: build.startedById,
		startedAt: build.startedAt,
		heartbeatAt: build.heartbeatAt,
		workflowId: build.workflowId,
	};
}

// ---------------------------------------------------------------------------
// Attempt-guarded writes
// ---------------------------------------------------------------------------

/** The attempt's own row, while it still holds its edition's claim. */
function heldAttempt(buildId: string): Prisma.GlossyBuildWhereInput {
	return {
		id: buildId,
		status: "BUILDING",
		document: { glossyEdition: { is: { currentBuildId: buildId } } },
	};
}

/**
 * Lock the attempt's own row FOR UPDATE, whatever its status, and read it:
 * the first statement of every writer that also changes the edition (see the
 * lock order in the module comment). Prisma has no `FOR UPDATE`, hence raw
 * SQL. Null when the row is gone.
 */
async function lockAttempt(
	tx: Client,
	buildId: string,
): Promise<{ documentId: string; startedAt: Date } | null> {
	const rows = await tx.$queryRaw<{ documentId: string; startedAt: Date }[]>`
		SELECT "documentId", "startedAt" FROM "glossy_build"
		WHERE "id" = ${buildId}
		FOR UPDATE`;
	return rows[0] ?? null;
}

export interface GlossyBuildProgress {
	step?: string;
	sectionsDone?: number;
	sectionsTotal?: number | null;
}

/**
 * Heartbeat the attempt, optionally with progress. `superseded` means the
 * attempt no longer holds the claim and the run must stop.
 */
export async function heartbeatGlossyBuild(
	buildId: string,
	progress: GlossyBuildProgress = {},
	now: Date = new Date(),
): Promise<GlossyGuardedOutcome> {
	const { count } = await db.glossyBuild.updateMany({
		where: heldAttempt(buildId),
		data: {
			heartbeatAt: now,
			...(progress.step !== undefined && { progressStep: progress.step }),
			...(progress.sectionsDone !== undefined && {
				sectionsDone: progress.sectionsDone,
			}),
			...(progress.sectionsTotal !== undefined && {
				sectionsTotal: progress.sectionsTotal,
			}),
		},
	});
	return count > 0 ? "applied" : "superseded";
}

export interface GlossyBuildSnapshot {
	buildId: string;
	documentId: string;
	projectId: string;
	organizationId: string;
	status: GlossyBuildStatus;
	startedById: string | null;
	startedAt: Date;
	options: Prisma.JsonValue;
	title: string;
	content: string;
	version: number;
	contentHash: string;
}

/**
 * The source snapshot of one attempt. A run reads only its own snapshot, and
 * regenerate reads the published attempt's, never the live document.
 */
export async function getGlossyBuildSnapshot(
	buildId: string,
): Promise<GlossyBuildSnapshot | null> {
	const build = await db.glossyBuild.findUnique({
		where: { id: buildId },
		select: {
			id: true,
			documentId: true,
			projectId: true,
			organizationId: true,
			status: true,
			startedById: true,
			startedAt: true,
			options: true,
			sourceTitle: true,
			sourceContent: true,
			sourceVersion: true,
			sourceContentHash: true,
		},
	});
	if (!build) {
		return null;
	}
	return {
		buildId: build.id,
		documentId: build.documentId,
		projectId: build.projectId,
		organizationId: build.organizationId,
		status: build.status as GlossyBuildStatus,
		startedById: build.startedById,
		startedAt: build.startedAt,
		options: build.options,
		title: build.sourceTitle,
		content: build.sourceContent,
		version: build.sourceVersion,
		contentHash: build.sourceContentHash,
	};
}

export interface FinalizeGlossyBuildInput {
	buildId: string;
	content: Prisma.InputJsonValue;
	report: Prisma.InputJsonValue;
	/**
	 * Every section key in the new content. Review decisions whose section is
	 * not among them are pruned; decisions for a section that still exists
	 * survive even when this build omitted their visual.
	 */
	sectionKeys: string[];
	/** Cache rows this build used; stamped so the prune below keeps them. */
	usedCacheKeys: { kind: GlossyCacheKind; cacheKey: string }[];
	now?: Date;
}

export type FinalizeGlossyBuildResult =
	| { outcome: "applied"; editionId: string; contentRevision: number }
	| { outcome: "superseded" };

/**
 * Publish the attempt, in one transaction:
 *
 *  1. lock the attempt row FOR UPDATE, so a cache write by this attempt
 *     either commits before anything below or waits and is `superseded`;
 *  2. swap content and `publishedBuildId`, release the claim, and bump
 *     `contentRevision` — guarded on `currentBuildId = buildId`;
 *  3. mark the attempt SUCCEEDED;
 *  4. stamp `lastUsedAt` on the cache rows it used, then delete the
 *     document's rows last used before the claim — rows written during the
 *     build, such as a concurrent Align-first detection, survive;
 *  5. prune decisions whose section no longer exists;
 *  6. delete every other finished attempt of the document.
 *
 * `superseded` means another attempt holds the claim; nothing was written.
 */
export async function finalizeGlossyBuild(
	input: FinalizeGlossyBuildInput,
): Promise<FinalizeGlossyBuildResult> {
	const now = input.now ?? new Date();
	return db.$transaction(async (tx) => {
		const build = await lockAttempt(tx, input.buildId);
		if (!build) {
			return { outcome: "superseded" as const };
		}

		const swapped = await tx.glossyEdition.updateMany({
			where: {
				documentId: build.documentId,
				currentBuildId: input.buildId,
			},
			data: {
				content: input.content,
				publishedBuildId: input.buildId,
				currentBuildId: null,
				contentRevision: { increment: 1 },
			},
		});
		if (swapped.count === 0) {
			return { outcome: "superseded" as const };
		}

		const finished = await tx.glossyBuild.updateMany({
			where: { id: input.buildId, status: "BUILDING" },
			data: {
				status: "SUCCEEDED",
				finishedAt: now,
				heartbeatAt: now,
				report: input.report,
			},
		});
		if (finished.count === 0) {
			throw new GlossyBuildInvariantError(
				"The attempt held the claim but was not BUILDING",
			);
		}

		const edition = await tx.glossyEdition.findUniqueOrThrow({
			where: { documentId: build.documentId },
			select: { id: true, contentRevision: true },
		});

		const keysByKind = new Map<GlossyCacheKind, string[]>();
		for (const { kind, cacheKey } of input.usedCacheKeys) {
			keysByKind.set(kind, [...(keysByKind.get(kind) ?? []), cacheKey]);
		}
		if (keysByKind.size > 0) {
			await tx.glossySegmentCache.updateMany({
				where: {
					documentId: build.documentId,
					OR: [...keysByKind].map(([kind, cacheKeys]) => ({
						kind,
						cacheKey: { in: cacheKeys },
					})),
				},
				data: { lastUsedAt: now },
			});
		}
		await tx.glossySegmentCache.deleteMany({
			where: {
				documentId: build.documentId,
				lastUsedAt: { lt: build.startedAt },
			},
		});

		await tx.glossyVisualDecision.deleteMany({
			where: {
				editionId: edition.id,
				sectionKey: { notIn: input.sectionKeys },
			},
		});

		await tx.glossyBuild.deleteMany({
			where: {
				documentId: build.documentId,
				id: { not: input.buildId },
				status: { not: "BUILDING" },
			},
		});

		return {
			outcome: "applied" as const,
			editionId: edition.id,
			contentRevision: edition.contentRevision,
		};
	});
}

export interface FailGlossyBuildInput {
	buildId: string;
	/** A fixed code, e.g. `AI_PROVIDER_NOT_CONFIGURED`. */
	errorCode: string;
	/** A fixed or already-redacted message; truncated here. */
	errorMessage: string;
	now?: Date;
}

/**
 * Record the attempt as FAILED and release the claim, locking the attempt row
 * before the edition row as finalize does. The published edition is
 * untouched, so viewers keep the previous one (marked "last rebuild failed" by
 * the reader, from the latest attempt's status).
 */
export async function failGlossyBuild(
	input: FailGlossyBuildInput,
): Promise<GlossyGuardedOutcome> {
	const now = input.now ?? new Date();
	return db.$transaction(async (tx) => {
		const build = await lockAttempt(tx, input.buildId);
		if (!build) {
			return "superseded" as const;
		}
		const released = await tx.glossyEdition.updateMany({
			where: {
				documentId: build.documentId,
				currentBuildId: input.buildId,
			},
			data: { currentBuildId: null },
		});
		if (released.count === 0) {
			return "superseded" as const;
		}
		const failed = await tx.glossyBuild.updateMany({
			where: { id: input.buildId, status: "BUILDING" },
			data: {
				status: "FAILED",
				finishedAt: now,
				errorCode: input.errorCode,
				errorMessage: input.errorMessage.slice(
					0,
					GLOSSY_ERROR_MESSAGE_MAX_LENGTH,
				),
			},
		});
		if (failed.count === 0) {
			throw new GlossyBuildInvariantError(
				"The attempt held the claim but was not BUILDING",
			);
		}
		return "applied" as const;
	});
}

/**
 * Release a claim whose workflow never started, through the guarded fail
 * write, so a retry can claim again.
 */
export async function releaseGlossyClaim(
	buildId: string,
): Promise<GlossyGuardedOutcome> {
	return failGlossyBuild({
		buildId,
		errorCode: GLOSSY_WORKFLOW_START_FAILED,
		errorMessage: "The build could not be started.",
	});
}

/**
 * Mark a run's own attempt SUPERSEDED after one of its guards failed. Every
 * path that takes the claim away already moves the attempt off BUILDING, so
 * this is normally a no-op; it never touches an attempt that still holds the
 * claim, and never any other attempt.
 */
export async function markGlossyBuildSuperseded(
	buildId: string,
	now: Date = new Date(),
): Promise<"marked" | "unchanged"> {
	const build = await db.glossyBuild.findUnique({
		where: { id: buildId },
		select: {
			status: true,
			document: {
				select: { glossyEdition: { select: { currentBuildId: true } } },
			},
		},
	});
	if (
		!build ||
		build.status !== "BUILDING" ||
		build.document.glossyEdition?.currentBuildId === buildId
	) {
		return "unchanged";
	}
	// Attempt ids are never reused, so once the claim has moved away from this
	// one it cannot come back between the read above and this write.
	const { count } = await db.glossyBuild.updateMany({
		where: { id: buildId, status: "BUILDING" },
		data: { status: "SUPERSEDED", finishedAt: now },
	});
	return count > 0 ? "marked" : "unchanged";
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const BUILD_SUMMARY_SELECT = {
	id: true,
	status: true,
	startedById: true,
	startedAt: true,
	heartbeatAt: true,
	finishedAt: true,
	workflowId: true,
	progressStep: true,
	sectionsDone: true,
	sectionsTotal: true,
	errorCode: true,
	errorMessage: true,
	sourceTitle: true,
	sourceVersion: true,
	sourceContentHash: true,
} as const satisfies Prisma.GlossyBuildSelect;

export type GlossyBuildSummary = Prisma.GlossyBuildGetPayload<{
	select: typeof BUILD_SUMMARY_SELECT;
}>;

export interface GlossyVisualDecisionView {
	visualKey: string;
	sectionKey: string;
	decision: GlossyVisualDecisionValue;
	specHash: string | null;
	decidedById: string | null;
	updatedAt: Date;
}

export interface GlossyEditionView {
	id: string;
	documentId: string;
	projectId: string;
	organizationId: string;
	content: Prisma.JsonValue | null;
	contentRevision: number;
	publishedBuildId: string | null;
	currentBuildId: string | null;
	lastOptions: Prisma.JsonValue | null;
	updatedAt: Date;
	decisions: GlossyVisualDecisionView[];
	/** The attempt the content came from: out-of-date compares its source. */
	publishedBuild: GlossyBuildSummary | null;
	/** The attempt holding the claim, while one runs. */
	currentBuild: GlossyBuildSummary | null;
	/** The most recent attempt; FAILED here means "last rebuild failed". */
	latestAttempt: GlossyBuildSummary | null;
}

/**
 * The edition of a document, with its decisions and attempt summaries.
 * Explicit columns only: attempt snapshots are never loaded here.
 */
export async function getGlossyEdition(input: {
	documentId: string;
	projectId: string;
}): Promise<GlossyEditionView | null> {
	const edition = await db.glossyEdition.findFirst({
		where: { documentId: input.documentId, projectId: input.projectId },
		select: {
			id: true,
			documentId: true,
			projectId: true,
			organizationId: true,
			content: true,
			contentRevision: true,
			publishedBuildId: true,
			currentBuildId: true,
			lastOptions: true,
			updatedAt: true,
			decisions: {
				select: {
					visualKey: true,
					sectionKey: true,
					decision: true,
					specHash: true,
					decidedById: true,
					updatedAt: true,
				},
				orderBy: { visualKey: "asc" },
			},
		},
	});
	if (!edition) {
		return null;
	}

	const pointerIds = [
		edition.publishedBuildId,
		edition.currentBuildId,
	].filter((id): id is string => Boolean(id));
	const [pointed, latestAttempt] = await Promise.all([
		pointerIds.length > 0
			? db.glossyBuild.findMany({
					where: {
						documentId: edition.documentId,
						id: { in: pointerIds },
					},
					select: BUILD_SUMMARY_SELECT,
				})
			: Promise.resolve([] as GlossyBuildSummary[]),
		db.glossyBuild.findFirst({
			where: { documentId: edition.documentId },
			orderBy: { startedAt: "desc" },
			select: BUILD_SUMMARY_SELECT,
		}),
	]);
	const byId = new Map(pointed.map((build) => [build.id, build]));

	return {
		...edition,
		decisions: edition.decisions.map((decision) => ({
			...decision,
			decision: decision.decision as GlossyVisualDecisionValue,
		})),
		publishedBuild: edition.publishedBuildId
			? (byId.get(edition.publishedBuildId) ?? null)
			: null,
		currentBuild: edition.currentBuildId
			? (byId.get(edition.currentBuildId) ?? null)
			: null,
		latestAttempt,
	};
}

// ---------------------------------------------------------------------------
// Single-visual regenerate
// ---------------------------------------------------------------------------

export interface ApplyVisualRegenerationInput {
	documentId: string;
	projectId: string;
	/** The published attempt the caller read; its snapshot fed the extraction. */
	expectedPublishedBuildId: string;
	/** The content revision the caller spliced into. */
	expectedContentRevision: number;
	/** The published content with the one visual replaced. */
	content: Prisma.InputJsonValue;
	visualKey: string;
	/** The extraction output, cached only if the edition write applies. */
	cacheEntry: {
		cacheKey: string;
		sectionKey: string | null;
		output: Prisma.InputJsonValue;
	};
	now?: Date;
}

export type ApplyVisualRegenerationResult =
	| { outcome: "applied"; contentRevision: number }
	| { outcome: "superseded" };

/**
 * Write a regenerated visual. Guarded on the published attempt, the content
 * revision, and no build running, so a rebuild that claimed or published in
 * between, or another regenerate that wrote first, turns this into
 * `superseded` with nothing written — no cache row either. On `superseded`
 * the caller re-reads, re-applies its one-visual splice to the fresh content
 * without another model call, and tries again while the published attempt is
 * unchanged. An acceptance of the replaced visual is cleared.
 */
export async function applyVisualRegeneration(
	input: ApplyVisualRegenerationInput,
): Promise<ApplyVisualRegenerationResult> {
	const now = input.now ?? new Date();
	return db.$transaction(async (tx) => {
		const written = await tx.glossyEdition.updateMany({
			where: {
				documentId: input.documentId,
				projectId: input.projectId,
				publishedBuildId: input.expectedPublishedBuildId,
				contentRevision: input.expectedContentRevision,
				currentBuildId: null,
			},
			data: { content: input.content, contentRevision: { increment: 1 } },
		});
		if (written.count === 0) {
			return { outcome: "superseded" as const };
		}
		const edition = await tx.glossyEdition.findUniqueOrThrow({
			where: { documentId: input.documentId },
			select: {
				id: true,
				projectId: true,
				organizationId: true,
				contentRevision: true,
			},
		});
		await upsertCacheRow(tx, {
			documentId: input.documentId,
			projectId: edition.projectId,
			organizationId: edition.organizationId,
			kind: "EXTRACTION",
			cacheKey: input.cacheEntry.cacheKey,
			sectionKey: input.cacheEntry.sectionKey,
			output: input.cacheEntry.output,
			now,
		});
		await tx.glossyVisualDecision.deleteMany({
			where: {
				editionId: edition.id,
				visualKey: input.visualKey,
				decision: "ACCEPTED",
			},
		});
		return {
			outcome: "applied" as const,
			contentRevision: edition.contentRevision,
		};
	});
}

// ---------------------------------------------------------------------------
// Review decisions
// ---------------------------------------------------------------------------

export interface UpsertVisualDecisionInput {
	documentId: string;
	projectId: string;
	visualKey: string;
	sectionKey: string;
	decision: GlossyVisualDecisionValue;
	/** Required for ACCEPTED: the spec hash being approved. */
	specHash?: string | null;
	decidedById: string;
}

/**
 * Record a review decision for a visual. Returns null when the document has
 * no edition. The caller has already checked the visual key exists in the
 * current content.
 */
export async function upsertVisualDecision(
	input: UpsertVisualDecisionInput,
): Promise<GlossyVisualDecisionView | null> {
	if (input.decision === "ACCEPTED" && !input.specHash) {
		throw new Error("An acceptance must name the spec hash it approves");
	}
	const edition = await db.glossyEdition.findFirst({
		where: { documentId: input.documentId, projectId: input.projectId },
		select: { id: true, projectId: true, organizationId: true },
	});
	if (!edition) {
		return null;
	}
	const fields = {
		sectionKey: input.sectionKey,
		decision: input.decision,
		specHash: input.specHash ?? null,
		decidedById: input.decidedById,
	};
	const row = await db.glossyVisualDecision.upsert({
		where: {
			editionId_visualKey: {
				editionId: edition.id,
				visualKey: input.visualKey,
			},
		},
		create: {
			editionId: edition.id,
			projectId: edition.projectId,
			organizationId: edition.organizationId,
			visualKey: input.visualKey,
			...fields,
		},
		update: fields,
		select: {
			visualKey: true,
			sectionKey: true,
			decision: true,
			specHash: true,
			decidedById: true,
			updatedAt: true,
		},
	});
	return { ...row, decision: row.decision as GlossyVisualDecisionValue };
}

/** Remove a review decision (restore). True when one existed. */
export async function clearVisualDecision(input: {
	documentId: string;
	projectId: string;
	visualKey: string;
}): Promise<boolean> {
	const { count } = await db.glossyVisualDecision.deleteMany({
		where: {
			visualKey: input.visualKey,
			projectId: input.projectId,
			edition: { documentId: input.documentId },
		},
	});
	return count > 0;
}

// ---------------------------------------------------------------------------
// Segment cache
// ---------------------------------------------------------------------------

/** Cached outputs for the given keys of one kind, by cache key. */
export async function getCacheEntries(input: {
	documentId: string;
	kind: GlossyCacheKind;
	cacheKeys: string[];
}): Promise<Map<string, Prisma.JsonValue>> {
	if (input.cacheKeys.length === 0) {
		return new Map();
	}
	const rows = await db.glossySegmentCache.findMany({
		where: {
			documentId: input.documentId,
			kind: input.kind,
			cacheKey: { in: input.cacheKeys },
		},
		select: { cacheKey: true, output: true },
	});
	return new Map(rows.map((row) => [row.cacheKey, row.output]));
}

export interface PutCacheEntryInput {
	documentId: string;
	projectId: string;
	kind: GlossyCacheKind;
	cacheKey: string;
	sectionKey?: string | null;
	output: Prisma.InputJsonValue;
	/**
	 * The attempt writing the entry. When set, the write applies only while
	 * that attempt holds the claim; without it (Align-first detection in the
	 * request) it always applies.
	 */
	buildId?: string;
	now?: Date;
}

/**
 * Store a model output under its cache key. With `buildId`, the attempt row is
 * locked FOR SHARE first. Finalize and fail lock that row FOR UPDATE, and a
 * reclaim updates it, before any of them changes the edition, so each either
 * commits before this check (and the write is `superseded`) or waits until
 * this write has committed.
 */
export async function putCacheEntry(
	input: PutCacheEntryInput,
): Promise<GlossyGuardedOutcome> {
	const now = input.now ?? new Date();
	return db.$transaction(async (tx) => {
		let tenant: { projectId: string; organizationId: string } | null;
		if (input.buildId) {
			const rows = await tx.$queryRaw<
				{ projectId: string; organizationId: string }[]
			>`SELECT "projectId", "organizationId" FROM "glossy_build"
				WHERE "id" = ${input.buildId}
				AND "documentId" = ${input.documentId}
				AND "status" = 'BUILDING'
				FOR SHARE`;
			tenant = rows[0] ?? null;
			if (!tenant) {
				return "superseded" as const;
			}
		} else {
			const document = await tx.projectDocument.findFirst({
				where: { id: input.documentId, projectId: input.projectId },
				select: {
					projectId: true,
					project: { select: { organizationId: true } },
				},
			});
			const organizationId = document?.project.organizationId;
			if (!document || !organizationId) {
				throw new GlossyEditionTenantError(
					"The document is not in an organization project",
				);
			}
			tenant = { projectId: document.projectId, organizationId };
		}
		if (tenant.projectId !== input.projectId) {
			throw new GlossyEditionTenantError(
				"The cache entry names another project",
			);
		}
		await upsertCacheRow(tx, {
			documentId: input.documentId,
			projectId: tenant.projectId,
			organizationId: tenant.organizationId,
			kind: input.kind,
			cacheKey: input.cacheKey,
			sectionKey: input.sectionKey ?? null,
			output: input.output,
			now,
		});
		return "applied" as const;
	});
}

async function upsertCacheRow(
	client: Client,
	row: {
		documentId: string;
		projectId: string;
		organizationId: string;
		kind: GlossyCacheKind;
		cacheKey: string;
		sectionKey: string | null;
		output: Prisma.InputJsonValue;
		now: Date;
	},
): Promise<void> {
	await client.glossySegmentCache.upsert({
		where: {
			documentId_kind_cacheKey: {
				documentId: row.documentId,
				kind: row.kind,
				cacheKey: row.cacheKey,
			},
		},
		create: {
			documentId: row.documentId,
			projectId: row.projectId,
			organizationId: row.organizationId,
			kind: row.kind,
			cacheKey: row.cacheKey,
			sectionKey: row.sectionKey,
			output: row.output,
			lastUsedAt: row.now,
		},
		update: {
			sectionKey: row.sectionKey,
			output: row.output,
			lastUsedAt: row.now,
		},
		select: { id: true },
	});
}

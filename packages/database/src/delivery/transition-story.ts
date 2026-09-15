/**
 * Stage-transition enforcement — the single choke point for drafting-stage
 * writes on UserStory.
 *
 * Every writer of `UserStory.draftingStage` (generic update, drafting-stage
 * procedures, AI enhance, version restore, create-at-PUBLISHED, spike
 * acceptance, discovery completion, governed approval) calls
 * `enforceStageTransition` inside the transaction that performs the write.
 * It:
 *
 *   1. blocks transitions out of DEFER except to DECLINED / CLOSED / PLACEHOLDER;
 *   2. evaluates readiness when the target is PUBLISHED and throws
 *      `StageTransitionBlockedError` when an enforced gate is not met;
 *   3. under a GOVERNED project with configured approvers, records a
 *      `StageTransitionRequest` instead of allowing the write and reports
 *      `mode: "request"` so the caller skips the stage change.
 *
 * Concurrency follows the repository's optimistic compare-and-swap pattern
 * (see queries/project-repository-integrations.ts): `writeStage` updates with
 * `WHERE draftingStage = fromStage` and requires `count === 1`.
 *
 * Plan: docs/features/inverted-loop-delivery-tracks.md §F1
 */

import { db } from "../../prisma/client";
import type {
	LastEditSource,
	Prisma,
	PrismaClient,
} from "../../prisma/generated/client";
import type {
	DeliveryTrack,
	EngagementProfile,
	FeatureDraftingStage,
	StageTransitionRequestStatus,
} from "../../prisma/generated/enums";
import { getEngagementProfileConfig } from "../engagement-profiles";
import { getTenantContext, hasTenantContext } from "../tenant-context";
import { withRLSContext } from "../tenant-db";
import {
	DEFER_ALLOWED_TARGET_STAGES,
	evaluateReadiness,
	type ReadinessEnforcement,
	type ReadinessEvidence,
	type ReadinessGap,
	type ReadinessResult,
	resolveEffectiveTrack,
} from "./readiness";

export type DbClient = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class StageTransitionBlockedError extends Error {
	readonly code = "STAGE_TRANSITION_BLOCKED" as const;
	readonly missing: ReadinessGap[];
	readonly advisory: ReadinessGap[];
	readonly effectiveTrack: DeliveryTrack;
	readonly toStage: FeatureDraftingStage;

	constructor(params: {
		toStage: FeatureDraftingStage;
		readiness: ReadinessResult;
	}) {
		super(
			`Transition to ${params.toStage} blocked: ${params.readiness.missing.join(", ")}`,
		);
		this.name = "StageTransitionBlockedError";
		this.toStage = params.toStage;
		this.missing = params.readiness.missing;
		this.advisory = params.readiness.advisory;
		this.effectiveTrack = params.readiness.effectiveTrack;
	}
}

export class GovernedActorRequiredError extends Error {
	readonly code = "GOVERNED_ACTOR_REQUIRED" as const;
	constructor() {
		super(
			"This project requires stage transitions to be reviewed; the acting user must be provided.",
		);
		this.name = "GovernedActorRequiredError";
	}
}

export class StageTransitionConflictError extends Error {
	readonly code = "STAGE_TRANSITION_CONFLICT" as const;
	constructor(
		message = "The feature changed while this update was running.",
	) {
		super(message);
		this.name = "StageTransitionConflictError";
	}
}

export class StageApprovalError extends Error {
	readonly code:
		| "REQUEST_NOT_PENDING"
		| "NOT_AN_APPROVER"
		| "SELF_APPROVAL"
		| "REQUEST_NOT_FOUND";
	constructor(code: StageApprovalError["code"], message: string) {
		super(message);
		this.name = "StageApprovalError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Evidence providers (slices 3 / 4 register theirs; nothing registered = zeros)
// ---------------------------------------------------------------------------

export type ReadinessEvidenceProvider = (
	client: DbClient,
	params: { storyId: string; projectId: string },
) => Promise<Partial<ReadinessEvidence>>;

const evidenceProviders: ReadinessEvidenceProvider[] = [];

/**
 * Register a provider that contributes evidence (accepted spike runs,
 * completed integration contracts). Providers are merged; a throwing provider
 * marks evidence unavailable, which fails closed.
 */
export function registerReadinessEvidenceProvider(
	provider: ReadinessEvidenceProvider,
): () => void {
	evidenceProviders.push(provider);
	return () => {
		const idx = evidenceProviders.indexOf(provider);
		if (idx >= 0) {
			evidenceProviders.splice(idx, 1);
		}
	};
}

/** Exposed for tests. */
export function _resetReadinessEvidenceProviders(): void {
	evidenceProviders.length = 0;
}

export async function loadReadinessEvidence(
	client: DbClient,
	params: { storyId: string; projectId: string },
): Promise<ReadinessEvidence> {
	const evidence: ReadinessEvidence = {
		acceptedSpikeRuns: 0,
		integrationContractComplete: false,
	};
	for (const provider of evidenceProviders) {
		try {
			const partial = await provider(client, params);
			if (typeof partial.acceptedSpikeRuns === "number") {
				evidence.acceptedSpikeRuns += partial.acceptedSpikeRuns;
			}
			if (partial.integrationContractComplete) {
				evidence.integrationContractComplete = true;
			}
		} catch {
			return { ...evidence, evidenceUnavailable: true };
		}
	}
	return evidence;
}

// ---------------------------------------------------------------------------
// Project policy
// ---------------------------------------------------------------------------

export interface ProjectStagePolicy {
	profile: EngagementProfile;
	enforcement: ReadinessEnforcement;
	/** True when GOVERNED review is effective: profile requires it AND approvers are configured. */
	reviewRequired: boolean;
	approverCount: number;
	/** The project's tenant: organization id, or null for a personal project. */
	organizationId: string | null;
	/** The project owner (tenant identity for personal projects). */
	ownerUserId: string;
}

/**
 * Tenant columns for rows the delivery module writes on behalf of an actor.
 *
 * `user_owned` RLS policies check `organizationId = tenant` in org context
 * and `userId = current user AND organizationId IS NULL` in personal
 * context. On a personal project the tenant identity is therefore the
 * project OWNER, not whoever acted: a project-scoped guest approving a
 * personal-project transition must still produce rows the owner's policy
 * accepts. The actor is recorded separately (`requestedById`,
 * `reviewedById`, `changedBy`), so the audit trail is unaffected.
 */
export function tenantOwnerFor(
	policy: Pick<ProjectStagePolicy, "organizationId" | "ownerUserId">,
	actorUserId: string,
): { userId: string; organizationId: string | null } {
	return policy.organizationId
		? { userId: actorUserId, organizationId: policy.organizationId }
		: { userId: policy.ownerUserId, organizationId: null };
}

export async function loadProjectStagePolicy(
	client: DbClient,
	projectId: string,
): Promise<ProjectStagePolicy> {
	const project = await client.project.findUnique({
		where: { id: projectId },
		select: {
			engagementProfile: true,
			enforceSpecifyGate: true,
			enforceSpikeGate: true,
			enforceDiscoveryGate: true,
			organizationId: true,
			userId: true,
			_count: { select: { stageApprovers: true } },
		},
	});
	if (!project) {
		throw new Error("Project not found");
	}
	const profile = project.engagementProfile as EngagementProfile;
	const config = getEngagementProfileConfig(profile);
	const approverCount = project._count.stageApprovers;
	return {
		profile,
		enforcement: {
			specify: project.enforceSpecifyGate,
			spike: project.enforceSpikeGate,
			discovery: project.enforceDiscoveryGate,
		},
		reviewRequired:
			config.stageTransitionsRequireReview && approverCount > 0,
		approverCount,
		organizationId: project.organizationId ?? null,
		ownerUserId: project.userId,
	};
}

// ---------------------------------------------------------------------------
// Readiness (read-only helper for UI and run-start checks)
// ---------------------------------------------------------------------------

export interface StoryReadinessSnapshot extends ReadinessResult {
	draftingStage: FeatureDraftingStage;
	deliveryTrack: DeliveryTrack;
	reviewRequired: boolean;
}

/**
 * Compute readiness for a story without writing anything. Used by the UI
 * readiness panel and by run-start procedures (which must re-check because
 * evidence can change after PUBLISHED).
 */
export async function computeStoryReadiness(
	params: { storyId: string; projectId: string },
	client: DbClient = db,
): Promise<StoryReadinessSnapshot> {
	const [policy, story] = await Promise.all([
		loadProjectStagePolicy(client, params.projectId),
		client.userStory.findFirst({
			where: { id: params.storyId, projectId: params.projectId },
			select: {
				draftingStage: true,
				deliveryTrack: true,
				description: true,
				acceptanceCriteria: true,
			},
		}),
	]);
	if (!story) {
		throw new Error("Story not found");
	}
	const evidence = await loadReadinessEvidence(client, params);
	const readiness = evaluateReadiness({
		story: {
			deliveryTrack: story.deliveryTrack as DeliveryTrack,
			description: story.description,
			acceptanceCriteria: story.acceptanceCriteria,
		},
		profile: policy.profile,
		enforcement: policy.enforcement,
		evidence,
	});
	return {
		...readiness,
		draftingStage: story.draftingStage,
		deliveryTrack: story.deliveryTrack as DeliveryTrack,
		reviewRequired: policy.reviewRequired,
	};
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

export interface StageTransitionActor {
	userId: string;
	organizationId?: string | null;
}

export type StageTransitionReason =
	| "manual"
	| "enhance"
	| "restore"
	| "create"
	| "approval"
	| "spike_accepted"
	| "discovery_complete"
	| "system";

export interface StagePatch {
	description?: string | null;
	acceptanceCriteria?: string | null;
}

export interface EnforceStageTransitionParams {
	storyId: string;
	projectId: string;
	toStage: FeatureDraftingStage;
	reason: StageTransitionReason;
	/** Required when the project requires review (a request is recorded on behalf of the actor). */
	actor?: StageTransitionActor;
	/** Content that will be written together with the stage; evaluated as if applied. */
	patch?: StagePatch;
	/**
	 * Skip GOVERNED request creation. Only the approval path sets this, after
	 * verifying the approver. Readiness is still enforced.
	 */
	bypassGovernedReview?: boolean;
	/**
	 * For create-at-stage: the story row does not exist yet. Supply the
	 * candidate fields instead of a storyId lookup.
	 */
	candidate?: {
		deliveryTrack: DeliveryTrack;
		description?: string | null;
		acceptanceCriteria?: string | null;
		fromStage: FeatureDraftingStage;
	};
}

export type EnforceStageTransitionResult =
	| {
			mode: "apply";
			fromStage: FeatureDraftingStage;
			readiness: ReadinessResult | null;
			policy: ProjectStagePolicy;
	  }
	| {
			mode: "noop";
			fromStage: FeatureDraftingStage;
			readiness: ReadinessResult | null;
			policy: ProjectStagePolicy;
	  }
	| {
			mode: "request";
			fromStage: FeatureDraftingStage;
			requestId: string;
			readiness: ReadinessResult | null;
			policy: ProjectStagePolicy;
	  };

/**
 * Enforce a drafting-stage transition. Call inside the transaction that will
 * perform the write. Throws `StageTransitionBlockedError` when an enforced
 * gate fails; returns `mode: "request"` when the project requires review.
 */
export async function enforceStageTransition(
	client: DbClient,
	params: EnforceStageTransitionParams,
): Promise<EnforceStageTransitionResult> {
	const policy = await loadProjectStagePolicy(client, params.projectId);

	let fromStage: FeatureDraftingStage;
	let deliveryTrack: DeliveryTrack;
	let description: string | null | undefined;
	let acceptanceCriteria: string | null | undefined;

	if (params.candidate) {
		fromStage = params.candidate.fromStage;
		deliveryTrack = params.candidate.deliveryTrack;
		description = params.candidate.description;
		acceptanceCriteria = params.candidate.acceptanceCriteria;
	} else {
		const story = await client.userStory.findFirst({
			where: { id: params.storyId, projectId: params.projectId },
			select: {
				draftingStage: true,
				deliveryTrack: true,
				description: true,
				acceptanceCriteria: true,
			},
		});
		if (!story) {
			throw new Error("Story not found");
		}
		fromStage = story.draftingStage;
		deliveryTrack = story.deliveryTrack as DeliveryTrack;
		description = story.description;
		acceptanceCriteria = story.acceptanceCriteria;
	}

	if (fromStage === params.toStage) {
		return { mode: "noop", fromStage, readiness: null, policy };
	}

	// Content as it will be after the write.
	const effectiveDescription =
		params.patch && params.patch.description !== undefined
			? params.patch.description
			: description;
	const effectiveAcceptanceCriteria =
		params.patch && params.patch.acceptanceCriteria !== undefined
			? params.patch.acceptanceCriteria
			: acceptanceCriteria;

	const effectiveTrack = resolveEffectiveTrack(deliveryTrack, policy.profile);

	// Rule 1: DEFER may only move to the allowed parking stages.
	if (
		effectiveTrack === "DEFER" &&
		!DEFER_ALLOWED_TARGET_STAGES.has(params.toStage)
	) {
		const readiness = evaluateReadiness({
			story: {
				deliveryTrack,
				description: effectiveDescription,
				acceptanceCriteria: effectiveAcceptanceCriteria,
			},
			profile: policy.profile,
			enforcement: policy.enforcement,
			evidence: {
				acceptedSpikeRuns: 0,
				integrationContractComplete: false,
			},
		});
		throw new StageTransitionBlockedError({
			toStage: params.toStage,
			readiness,
		});
	}

	// Rule 2: PUBLISHED requires readiness.
	let readiness: ReadinessResult | null = null;
	if (params.toStage === "PUBLISHED") {
		const evidence = params.candidate
			? { acceptedSpikeRuns: 0, integrationContractComplete: false }
			: await loadReadinessEvidence(client, {
					storyId: params.storyId,
					projectId: params.projectId,
				});
		readiness = evaluateReadiness({
			story: {
				deliveryTrack,
				description: effectiveDescription,
				acceptanceCriteria: effectiveAcceptanceCriteria,
			},
			profile: policy.profile,
			enforcement: policy.enforcement,
			evidence,
		});
		if (!readiness.ready) {
			throw new StageTransitionBlockedError({
				toStage: params.toStage,
				readiness,
			});
		}
	}

	// Rule 3: GOVERNED review. Creates are never routed to review (there is no
	// story to review yet); every other transition is when review is effective.
	if (
		policy.reviewRequired &&
		!params.bypassGovernedReview &&
		!params.candidate
	) {
		if (!params.actor) {
			throw new GovernedActorRequiredError();
		}
		// Supersede any older pending request for this story so the partial
		// unique index (one PENDING per story) is satisfied.
		await client.stageTransitionRequest.updateMany({
			where: { storyId: params.storyId, status: "PENDING" },
			data: { status: "SUPERSEDED" },
		});
		const tenantOwner = tenantOwnerFor(policy, params.actor.userId);
		const request = await client.stageTransitionRequest.create({
			data: {
				projectId: params.projectId,
				storyId: params.storyId,
				requestedById: params.actor.userId,
				userId: tenantOwner.userId,
				organizationId: tenantOwner.organizationId,
				fromStage,
				toStage: params.toStage,
				patch: params.patch
					? (params.patch as Prisma.InputJsonValue)
					: undefined,
				reason: params.reason,
			},
			select: { id: true },
		});
		return {
			mode: "request",
			fromStage,
			requestId: request.id,
			readiness,
			policy,
		};
	}

	return { mode: "apply", fromStage, readiness, policy };
}

// ---------------------------------------------------------------------------
// Stage write (CAS) — shared by query-layer writers and the approval path
// ---------------------------------------------------------------------------

export interface WriteStageParams {
	storyId: string;
	projectId: string;
	fromStage: FeatureDraftingStage;
	toStage: FeatureDraftingStage;
	patch?: StagePatch;
	versionContext?: {
		userId?: string;
		organizationId?: string | null;
		changedBy?: string;
		changeDescription?: string;
	};
	/**
	 * Extra columns written in the same statement as the stage (e.g. the
	 * last-edit provenance tuple and `pmAutoHidden: false`), so the stage
	 * write stays one compare-and-swap.
	 */
	extraData?: {
		pmAutoHidden?: boolean;
		lastEditedAt?: Date;
		lastEditedByName?: string | null;
		lastEditedSource?: LastEditSource;
	};
}

/**
 * Snapshot the current content into FeatureVersion and write the new stage
 * with a compare-and-swap on the current stage. Throws
 * `StageTransitionConflictError` when a concurrent writer changed the stage.
 */
export async function writeStage(
	client: DbClient,
	params: WriteStageParams,
): Promise<void> {
	const current = await client.userStory.findFirst({
		where: { id: params.storyId, projectId: params.projectId },
		select: {
			version: true,
			description: true,
			acceptanceCriteria: true,
			draftingStage: true,
		},
	});
	if (!current) {
		throw new Error("Story not found");
	}
	if (current.draftingStage !== params.fromStage) {
		throw new StageTransitionConflictError();
	}

	await client.featureVersion.createMany({
		data: [
			{
				storyId: params.storyId,
				version: current.version ?? 1,
				description: current.description,
				acceptanceCriteria: current.acceptanceCriteria,
				draftingStage: current.draftingStage,
				changeDescription:
					params.versionContext?.changeDescription ?? null,
				changedBy: params.versionContext?.changedBy ?? null,
				userId: params.versionContext?.userId ?? null,
				organizationId: params.versionContext?.organizationId ?? null,
			},
		],
		skipDuplicates: true,
	});

	const updated = await client.userStory.updateMany({
		where: {
			id: params.storyId,
			projectId: params.projectId,
			draftingStage: params.fromStage,
		},
		data: {
			draftingStage: params.toStage,
			draftingStageUpdatedAt: new Date(),
			...(params.extraData ?? {}),
			...(params.patch?.description !== undefined
				? { description: params.patch.description }
				: {}),
			...(params.patch?.acceptanceCriteria !== undefined
				? { acceptanceCriteria: params.patch.acceptanceCriteria }
				: {}),
		},
	});
	if (updated.count !== 1) {
		throw new StageTransitionConflictError();
	}
}

// ---------------------------------------------------------------------------
// Governed approvals
// ---------------------------------------------------------------------------

/**
 * Run `fn` in a transaction whose RLS session variables are derived from the
 * PROJECT the request belongs to, not from the caller's session tenant.
 *
 * Why: row-level policies on `stage_transition_request` (user_owned) and
 * `project_stage_approver` (project_parent) key on the project's
 * organization. A project-scoped guest (accepted `ProjectMember`, no org
 * membership) runs under a *personal* session tenant, so the session-derived
 * `withRLSContext` would set credentials that cannot see the host
 * organization's rows and the approval would fail closed for a legitimate
 * approver. The caller has already passed `requireProjectPermission`, which
 * verified project access, so scoping the transaction to the project's own
 * tenant is both correct and minimal.
 *
 * With no active tenant context (worker-side callers) a plain transaction is
 * used, as those callers do today.
 */
async function withStageTransaction<T>(
	params: { requestId: string; projectId: string; userId: string },
	fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	if (!hasTenantContext()) {
		return await db.$transaction(fn);
	}
	// Resolve the tenant scope from the request row itself, read under the
	// caller's own session context. The row's tenant columns are the project
	// owner on personal projects and the org on org projects
	// (`tenantOwnerFor`), and the `project_member_or_tenant` policy admits
	// the read for org members, owners, and accepted project guests alike.
	// Reading the project row here would not work for guests: `project` is
	// user_owned and invisible to a guest's personal session.
	const scope = await withRLSContext(db, (tx) =>
		tx.stageTransitionRequest.findFirst({
			where: { id: params.requestId, projectId: params.projectId },
			select: { userId: true, organizationId: true },
		}),
	);
	if (!scope) {
		throw new StageApprovalError("REQUEST_NOT_FOUND", "Request not found");
	}
	const ctx = getTenantContext();
	const matchesSession = scope.organizationId
		? ctx.type === "organization" && ctx.tenantId === scope.organizationId
		: ctx.type === "personal" && ctx.userId === scope.userId;
	if (matchesSession) {
		return await withRLSContext(db, fn);
	}
	return await db.$transaction(async (tx) => {
		await tx.$executeRawUnsafe(
			"SELECT set_config('app.tenant_type', $1, true)",
			scope.organizationId ? "organization" : "personal",
		);
		await tx.$executeRawUnsafe(
			"SELECT set_config('app.tenant_id', $1, true)",
			scope.organizationId ?? "",
		);
		await tx.$executeRawUnsafe(
			"SELECT set_config('app.user_id', $1, true)",
			scope.organizationId
				? params.userId
				: (scope.userId ?? params.userId),
		);
		return await fn(tx);
	});
}

export interface ReviewStageTransitionParams {
	requestId: string;
	projectId: string;
	reviewer: StageTransitionActor;
	note?: string;
}

async function loadPendingRequest(
	client: DbClient,
	requestId: string,
	projectId: string,
) {
	const request = await client.stageTransitionRequest.findFirst({
		where: { id: requestId, projectId },
	});
	if (!request) {
		throw new StageApprovalError("REQUEST_NOT_FOUND", "Request not found");
	}
	if (request.status !== "PENDING") {
		throw new StageApprovalError(
			"REQUEST_NOT_PENDING",
			`Request is ${request.status.toLowerCase()}, not pending`,
		);
	}
	return request;
}

async function assertApprover(
	client: DbClient,
	projectId: string,
	reviewerId: string,
	requestedById: string,
) {
	if (reviewerId === requestedById) {
		throw new StageApprovalError(
			"SELF_APPROVAL",
			"The requester cannot approve their own transition",
		);
	}
	const approver = await client.projectStageApprover.findUnique({
		where: { projectId_userId: { projectId, userId: reviewerId } },
		select: { userId: true },
	});
	if (!approver) {
		throw new StageApprovalError(
			"NOT_AN_APPROVER",
			"Only configured approvers may review stage transitions on this project",
		);
	}
}

/**
 * Approve a pending request: verifies the approver, re-runs readiness at
 * approval time, applies the stage (and any patch) with CAS, and flips the
 * request to APPROVED — all in one transaction.
 */
export async function approveStageTransitionRequest(
	params: ReviewStageTransitionParams,
): Promise<{ storyId: string; toStage: FeatureDraftingStage }> {
	return await withStageTransaction(
		{
			requestId: params.requestId,
			projectId: params.projectId,
			userId: params.reviewer.userId,
		},
		async (tx) => {
			const request = await loadPendingRequest(
				tx,
				params.requestId,
				params.projectId,
			);
			await assertApprover(
				tx,
				params.projectId,
				params.reviewer.userId,
				request.requestedById,
			);

			const patch = (request.patch ?? undefined) as
				| StagePatch
				| undefined;
			const decision = await enforceStageTransition(tx, {
				storyId: request.storyId,
				projectId: params.projectId,
				toStage: request.toStage,
				reason: "approval",
				actor: params.reviewer,
				patch,
				bypassGovernedReview: true,
			});
			if (decision.mode === "apply") {
				await writeStage(tx, {
					storyId: request.storyId,
					projectId: params.projectId,
					fromStage: decision.fromStage,
					toStage: request.toStage,
					patch,
					versionContext: {
						// Tenant identity for the FeatureVersion row (project
						// owner on personal projects); the reviewer stays in
						// `changedBy` and on the request's `reviewedById`.
						...tenantOwnerFor(
							decision.policy,
							params.reviewer.userId,
						),
						changedBy: params.reviewer.userId,
						changeDescription: `Approved transition to ${request.toStage.toLowerCase().replace(/_/g, " ")}`,
					},
				});
			}
			// decision.mode === "noop": the story already reached the stage; still close the request.

			const flipped = await tx.stageTransitionRequest.updateMany({
				where: { id: request.id, status: "PENDING" },
				data: {
					status: "APPROVED" satisfies StageTransitionRequestStatus,
					reviewedById: params.reviewer.userId,
					reviewedAt: new Date(),
					reviewNote: params.note ?? null,
				},
			});
			if (flipped.count !== 1) {
				throw new StageApprovalError(
					"REQUEST_NOT_PENDING",
					"Request was reviewed concurrently",
				);
			}
			return { storyId: request.storyId, toStage: request.toStage };
		},
	);
}

export async function rejectStageTransitionRequest(
	params: ReviewStageTransitionParams,
): Promise<{ storyId: string }> {
	return await withStageTransaction(
		{
			requestId: params.requestId,
			projectId: params.projectId,
			userId: params.reviewer.userId,
		},
		async (tx) => {
			const request = await loadPendingRequest(
				tx,
				params.requestId,
				params.projectId,
			);
			await assertApprover(
				tx,
				params.projectId,
				params.reviewer.userId,
				request.requestedById,
			);
			const flipped = await tx.stageTransitionRequest.updateMany({
				where: { id: request.id, status: "PENDING" },
				data: {
					status: "REJECTED",
					reviewedById: params.reviewer.userId,
					reviewedAt: new Date(),
					reviewNote: params.note ?? null,
				},
			});
			if (flipped.count !== 1) {
				throw new StageApprovalError(
					"REQUEST_NOT_PENDING",
					"Request was reviewed concurrently",
				);
			}
			return { storyId: request.storyId };
		},
	);
}

export async function listStageTransitionRequests(params: {
	projectId: string;
	status?: StageTransitionRequestStatus | StageTransitionRequestStatus[];
	storyId?: string;
	limit?: number;
}) {
	const statusFilter = Array.isArray(params.status)
		? { in: params.status }
		: params.status;
	return await db.stageTransitionRequest.findMany({
		where: {
			projectId: params.projectId,
			...(statusFilter !== undefined ? { status: statusFilter } : {}),
			...(params.storyId ? { storyId: params.storyId } : {}),
		},
		orderBy: { createdAt: "desc" },
		take: params.limit ?? 100,
		include: {
			story: { select: { id: true, identifier: true, title: true } },
			requestedBy: { select: { id: true, name: true, email: true } },
			reviewedBy: { select: { id: true, name: true, email: true } },
		},
	});
}

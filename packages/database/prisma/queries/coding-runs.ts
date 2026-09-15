/**
 * Coding Runs Queries
 *
 * Database queries for CodingRun and CodingRunEvent models.
 * All queries follow the XOR tenant isolation pattern:
 * - Personal context: userId is set, organizationId is NULL
 * - Org context: organizationId is set
 */

import {
	GovernedActorRequiredError,
	StageTransitionBlockedError,
	StageTransitionConflictError,
} from "../../src/delivery/transition-story";
import { db } from "../client";
import type {
	CodingRunExecutionChannel,
	CodingRunKind,
	CodingRunProvider,
	CodingRunStatus,
	DeliveryTrack,
	FeatureDraftingStage,
	Prisma,
} from "../generated/client";
import { updateStoryDraftingStage } from "./projects/stories";

function getTenantFilter(params: {
	userId: string;
	organizationId?: string | null;
}) {
	if (params.organizationId) {
		return { organizationId: params.organizationId };
	}
	return { userId: params.userId, organizationId: null };
}

export async function createCodingRun(params: {
	projectId: string;
	storyId: string;
	storyTaskId?: string;
	userId: string;
	organizationId?: string | null;
	weaveExecutionId?: string;
	executionChannel?: CodingRunExecutionChannel;
	provider?: CodingRunProvider;
	repositoryUrl?: string;
	repositoryOwner?: string;
	repositoryName?: string;
	targetBranch?: string;
	workingDirectory?: string;
	externalUrl?: string;
	externalStatus?: string;
	providerMetadata?: Prisma.InputJsonValue;
	promptText?: string;
	workflowId?: string;
	kind?: CodingRunKind;
	spikeQuestion?: string;
}) {
	return db.codingRun.create({
		data: {
			projectId: params.projectId,
			storyId: params.storyId,
			storyTaskId: params.storyTaskId,
			userId: params.userId,
			organizationId: params.organizationId ?? undefined,
			weaveExecutionId: params.weaveExecutionId,
			executionChannel: params.executionChannel ?? "BACKGROUND_AGENTS",
			provider: params.provider ?? "BACKGROUND_AGENTS",
			repositoryUrl: params.repositoryUrl,
			repositoryOwner: params.repositoryOwner,
			repositoryName: params.repositoryName,
			targetBranch: params.targetBranch,
			workingDirectory: params.workingDirectory,
			externalUrl: params.externalUrl,
			externalStatus: params.externalStatus,
			providerMetadata: params.providerMetadata,
			promptText: params.promptText,
			workflowId: params.workflowId,
			kind: params.kind ?? "IMPLEMENT",
			spikeQuestion: params.spikeQuestion,
		},
	});
}

export async function getCodingRun(
	id: string,
	userId: string,
	organizationId?: string | null,
) {
	const tenantFilter = getTenantFilter({ userId, organizationId });
	return db.codingRun.findFirst({
		where: { id, ...tenantFilter },
		include: {
			events: { orderBy: { createdAt: "asc" } },
			story: { select: { id: true, title: true, identifier: true } },
			storyTask: { select: { id: true, title: true, identifier: true } },
		},
	});
}

export async function listCodingRunsForStory(
	storyId: string,
	userId: string,
	organizationId?: string | null,
) {
	const tenantFilter = getTenantFilter({ userId, organizationId });
	return db.codingRun.findMany({
		where: { storyId, ...tenantFilter },
		include: {
			storyTask: { select: { id: true, title: true, identifier: true } },
		},
		orderBy: { createdAt: "desc" },
	});
}

export async function listCodingRunsForTask(
	storyTaskId: string,
	userId: string,
	organizationId?: string | null,
) {
	const tenantFilter = getTenantFilter({ userId, organizationId });
	return db.codingRun.findMany({
		where: { storyTaskId, ...tenantFilter },
		orderBy: { createdAt: "desc" },
	});
}

export async function updateCodingRunStatus(
	id: string,
	status: CodingRunStatus,
	data?: {
		providerSessionId?: string;
		pullRequestUrl?: string;
		pullRequestNumber?: number;
		pullRequestBranch?: string;
		externalUrl?: string;
		externalStatus?: string;
		providerMetadata?: Prisma.InputJsonValue;
		/** Spike runs (plan Slice 3). */
		spikeBranch?: string;
		findings?: string;
		demoFrameId?: string;
		demoUrl?: string;
		playNotes?: string;
		promptText?: string;
	},
) {
	return db.codingRun.update({
		where: { id },
		data: {
			status,
			...data,
		},
	});
}

export async function addCodingRunEvent(
	codingRunId: string,
	eventType: string,
	payload?: Record<string, unknown>,
	providerEventId?: string,
) {
	return db.codingRunEvent.create({
		data: {
			codingRunId,
			eventType,
			payloadJson: (payload as Prisma.InputJsonValue) ?? undefined,
			providerEventId,
		},
	});
}

export async function getLatestCodingRunForStory(
	storyId: string,
	userId: string,
	organizationId?: string | null,
) {
	const tenantFilter = getTenantFilter({ userId, organizationId });
	return db.codingRun.findFirst({
		where: { storyId, ...tenantFilter },
		orderBy: { createdAt: "desc" },
		select: {
			id: true,
			weaveExecutionId: true,
			executionChannel: true,
			provider: true,
			status: true,
			providerSessionId: true,
			pullRequestUrl: true,
			pullRequestNumber: true,
			externalUrl: true,
			createdAt: true,
			// Spike runs (plan Slice 3)
			kind: true,
			spikeQuestion: true,
			demoFrameId: true,
			demoUrl: true,
		},
	});
}

// ---------------------------------------------------------------------------
// Spike runs (plan Slice 3)
// ---------------------------------------------------------------------------

/** The run does not exist in the caller's project/tenant scope. */
export class SpikeRunNotFoundError extends Error {
	constructor(message = "Coding run not found") {
		super(message);
		this.name = "SpikeRunNotFoundError";
	}
}

/** The run exists but is not a DEMO_READY spike (or lacks findings). */
export class SpikeRunStateError extends Error {
	readonly status: CodingRunStatus;
	readonly kind: CodingRunKind;
	constructor(
		status: CodingRunStatus,
		kind: CodingRunKind,
		message?: string,
	) {
		super(
			message ??
				(kind !== "SPIKE"
					? "This run is not a spike."
					: `Spike run is ${status}, expected DEMO_READY.`),
		);
		this.name = "SpikeRunStateError";
		this.status = status;
		this.kind = kind;
	}
}

/** Stages at which a spike acceptance advances the story to ACTIVE_ANALYSIS. */
const STAGES_BELOW_ACTIVE_ANALYSIS: ReadonlySet<FeatureDraftingStage> = new Set(
	["PLACEHOLDER", "PASSIVE_ANALYSIS"],
);

export type SpikeTrackChoice = Extract<
	DeliveryTrack,
	"SPIKE" | "DISCOVERY" | "SPECIFY" | "DEFER"
>;

function spikeFindingsHeading(codingRunId: string): string {
	return `Spike findings (run ${codingRunId})`;
}

/**
 * Append a spike findings section to a story description. The description
 * is either TipTap JSON (`{ type: "doc" }`) or plain/markdown text; the
 * section is appended in the same format so the editor keeps rendering it.
 * Exported for tests and for the Temporal activity.
 */
export function appendSpikeFindingsToDescription(
	description: string | null,
	params: { codingRunId: string; findings: string; demoUrl: string | null },
): string {
	const heading = spikeFindingsHeading(params.codingRunId);
	const demoLine = params.demoUrl ? `Demo: ${params.demoUrl}` : null;

	const trimmed = description?.trim() ?? "";
	if (trimmed.startsWith("{")) {
		try {
			const doc = JSON.parse(trimmed) as {
				type?: unknown;
				content?: unknown;
			};
			if (doc && doc.type === "doc") {
				const content = Array.isArray(doc.content) ? doc.content : [];
				const paragraphs = params.findings
					.split(/\n\s*\n/)
					.map((block) => block.trim())
					.filter(Boolean)
					.map((block) => ({
						type: "paragraph",
						content: [{ type: "text", text: block }],
					}));
				const nodes: unknown[] = [
					{
						type: "heading",
						attrs: { level: 2 },
						content: [{ type: "text", text: heading }],
					},
					...paragraphs,
				];
				if (demoLine) {
					nodes.push({
						type: "paragraph",
						content: [{ type: "text", text: demoLine }],
					});
				}
				return JSON.stringify({
					...doc,
					content: [...content, ...nodes],
				});
			}
		} catch {
			// Not JSON after all: fall through to the text form.
		}
	}

	const section = [`## ${heading}`, "", params.findings.trim()];
	if (demoLine) {
		section.push("", demoLine);
	}
	return trimmed ? `${trimmed}\n\n${section.join("\n")}` : section.join("\n");
}

export interface ApplySpikeFindingsParams {
	codingRunId: string;
	/** Project the run must belong to (verified by the caller's middleware). */
	projectId: string;
	/** Tenant scope (XOR): org id, or null/undefined for personal. */
	organizationId?: string | null;
	/** Acting user; recorded as `changedBy` on the version and the stage change. */
	userId: string;
	playNotes: string;
	nextTrack?: SpikeTrackChoice;
}

export interface ApplySpikeFindingsResult {
	codingRunId: string;
	status: "COMPLETED";
	storyId: string;
	projectId: string;
	version: number;
	/** What happened to the drafting stage after the findings were applied. */
	stageTransition:
		| { outcome: "applied"; toStage: "ACTIVE_ANALYSIS" }
		| { outcome: "requested"; requestId: string }
		| { outcome: "skipped"; reason: "already_at_or_above" }
		| { outcome: "blocked"; reason: string };
}

/**
 * Accept a spike (plan Slice 3): append the findings to the story
 * description, snapshot a `FeatureVersion`, record play notes, set the run
 * COMPLETED (which is what the readiness evidence provider counts), and
 * optionally set the next delivery track. Runs in one transaction; the
 * drafting-stage advance to ACTIVE_ANALYSIS runs afterwards through the
 * stage choke point and its own transaction, and a governed request or a
 * blocked gate does not fail the acceptance.
 */
export async function applySpikeFindings(
	params: ApplySpikeFindingsParams,
): Promise<ApplySpikeFindingsResult> {
	const organizationId = params.organizationId ?? null;

	const applied = await db.$transaction(async (tx) => {
		const run = await tx.codingRun.findFirst({
			where: {
				id: params.codingRunId,
				projectId: params.projectId,
				organizationId,
			},
			select: {
				id: true,
				kind: true,
				status: true,
				storyId: true,
				projectId: true,
				findings: true,
				demoUrl: true,
			},
		});
		if (!run) {
			throw new SpikeRunNotFoundError();
		}
		if (run.kind !== "SPIKE" || run.status !== "DEMO_READY") {
			throw new SpikeRunStateError(run.status, run.kind);
		}
		if (!run.findings) {
			// DEMO_READY is only ever written together with findings; a bare
			// row is corrupt and must not be counted as evidence.
			throw new SpikeRunStateError(
				run.status,
				run.kind,
				"Spike run has no findings to apply.",
			);
		}

		const story = await tx.userStory.findFirst({
			where: { id: run.storyId, projectId: run.projectId },
			select: {
				id: true,
				version: true,
				description: true,
				acceptanceCriteria: true,
				draftingStage: true,
			},
		});
		if (!story) {
			throw new SpikeRunNotFoundError("Story not found");
		}

		const nextDescription = appendSpikeFindingsToDescription(
			story.description,
			{
				codingRunId: run.id,
				findings: run.findings,
				demoUrl: run.demoUrl,
			},
		);

		// Same numbering rule as AI enhance: the next version is one past the
		// highest snapshot or the story's own counter, whichever is larger.
		const maxVersion = await tx.featureVersion.findFirst({
			where: { storyId: story.id },
			orderBy: { version: "desc" },
			select: { version: true },
		});
		const nextVersion =
			Math.max(story.version ?? 1, maxVersion?.version ?? 0) + 1;

		await tx.featureVersion.create({
			data: {
				storyId: story.id,
				version: nextVersion,
				description: nextDescription,
				acceptanceCriteria: story.acceptanceCriteria,
				draftingStage: story.draftingStage,
				changeDescription: `Spike findings applied (run ${run.id})`,
				changedBy: params.userId,
				userId: params.userId,
				organizationId,
			},
		});

		await tx.userStory.update({
			where: { id: story.id },
			data: {
				description: nextDescription,
				version: nextVersion,
				...(params.nextTrack
					? {
							deliveryTrack: params.nextTrack,
							trackSetBy: "HUMAN",
							trackRationale: "Set on spike acceptance",
							trackUpdatedAt: new Date(),
						}
					: {}),
			},
		});

		// Compare-and-swap on status so two concurrent acceptances cannot
		// both succeed.
		const updated = await tx.codingRun.updateMany({
			where: { id: run.id, status: "DEMO_READY" },
			data: {
				status: "COMPLETED",
				playNotes: params.playNotes,
			},
		});
		if (updated.count !== 1) {
			throw new SpikeRunStateError("COMPLETED", "SPIKE");
		}

		return {
			storyId: story.id,
			projectId: run.projectId,
			draftingStage: story.draftingStage,
			version: nextVersion,
		};
	});

	let stageTransition: ApplySpikeFindingsResult["stageTransition"];
	if (!STAGES_BELOW_ACTIVE_ANALYSIS.has(applied.draftingStage)) {
		stageTransition = {
			outcome: "skipped",
			reason: "already_at_or_above",
		};
	} else {
		try {
			const result = await updateStoryDraftingStage(
				applied.storyId,
				applied.projectId,
				"ACTIVE_ANALYSIS",
				{
					userId: params.userId,
					organizationId: organizationId ?? undefined,
					changedBy: params.userId,
					changeDescription: `Spike accepted (run ${params.codingRunId})`,
					transitionReason: "spike_accepted",
					// A reviewer accepts the spike by hand (play notes required).
					lastEditedSource: "MANUAL",
				},
			);
			const requestId = (result as { pendingStageRequestId?: string })
				.pendingStageRequestId;
			stageTransition = requestId
				? { outcome: "requested", requestId }
				: { outcome: "applied", toStage: "ACTIVE_ANALYSIS" };
		} catch (error) {
			if (
				error instanceof StageTransitionBlockedError ||
				error instanceof GovernedActorRequiredError ||
				error instanceof StageTransitionConflictError
			) {
				stageTransition = { outcome: "blocked", reason: error.message };
			} else {
				throw error;
			}
		}
	}

	return {
		codingRunId: params.codingRunId,
		status: "COMPLETED",
		storyId: applied.storyId,
		projectId: applied.projectId,
		version: applied.version,
		stageTransition,
	};
}

/**
 * Discard a DEMO_READY spike: the run becomes CANCELLED, the demo frame is
 * kept for reference, and an optional reason is recorded as play notes.
 * Compare-and-swap on status so a concurrent accept wins cleanly.
 */
export async function discardSpikeRun(params: {
	codingRunId: string;
	projectId: string;
	organizationId?: string | null;
	reason?: string;
}): Promise<{ codingRunId: string; status: "CANCELLED"; storyId: string }> {
	const organizationId = params.organizationId ?? null;
	const run = await db.codingRun.findFirst({
		where: {
			id: params.codingRunId,
			projectId: params.projectId,
			organizationId,
		},
		select: { id: true, kind: true, status: true, storyId: true },
	});
	if (!run) {
		throw new SpikeRunNotFoundError();
	}
	if (run.kind !== "SPIKE" || run.status !== "DEMO_READY") {
		throw new SpikeRunStateError(run.status, run.kind);
	}
	const updated = await db.codingRun.updateMany({
		where: { id: run.id, status: "DEMO_READY" },
		data: {
			status: "CANCELLED",
			...(params.reason ? { playNotes: params.reason } : {}),
		},
	});
	if (updated.count !== 1) {
		throw new SpikeRunStateError("COMPLETED", "SPIKE");
	}
	return { codingRunId: run.id, status: "CANCELLED", storyId: run.storyId };
}

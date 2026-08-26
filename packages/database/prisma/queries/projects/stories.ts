/**
 * Database queries for User Stories & Tasks
 * Handles CRUD operations for Kanban board functionality
 */

import {
	db,
	type FeatureDraftingStage,
	type LastEditSource,
	type MaturationStatus,
	type PriorityChangeSource,
	Prisma,
	type ReporterSource,
	type StoryKind,
	type StoryPriority,
	type StorySize,
	type StorySource,
} from "../../client";
import { buildFabricStoryUrl, placeFabricBackLink } from "./fabric-url";
import { recordPriorityMove } from "./priority-history";

/**
 * Thrown when a story write loses an optimistic-concurrency race — either the
 * caller's `expectedVersion` no longer matches, or the guarded `updateMany`
 * matched zero rows because another writer committed between this
 * transaction's read and its write.
 *
 * It exists so callers can tell "somebody else got there first" (retryable,
 * expected under concurrent editing) apart from a genuine failure. Thrown as a
 * bare `Error`, oRPC's `toORPCError` defaulted it to INTERNAL_SERVER_ERROR and
 * dropped the message, so the editor showed "Internal server error" for what is
 * a routine, self-healing conflict.
 *
 * `message` is deliberately user-facing: the API layer maps this to a CONFLICT
 * and the text reaches the client.
 */
export class StoryVersionConflictError extends Error {
	readonly storyId: string;

	constructor(storyId: string) {
		super(
			"Feature was updated by another request. Please refresh and try again.",
		);
		this.name = "StoryVersionConflictError";
		this.storyId = storyId;
	}
}

// ============================================================================
// Story Status Queries (Kanban Columns)
// ============================================================================

/**
 * Default statuses to create for new projects
 */
export const DEFAULT_STORY_STATUSES = [
	{
		name: "Backlog",
		color: "#6B7280",
		order: 0,
		isDefault: true,
		isFinal: false,
	},
	{
		name: "In Progress",
		color: "#F59E0B",
		order: 1,
		isDefault: false,
		isFinal: false,
	},
	{
		name: "Review",
		color: "#8B5CF6",
		order: 2,
		isDefault: false,
		isFinal: false,
	},
	{
		name: "Ready",
		color: "#3B82F6",
		order: 3,
		isDefault: false,
		isFinal: false,
	},
	{
		name: "Done",
		color: "#10B981",
		order: 4,
		isDefault: false,
		isFinal: true,
	},
] as const;

/**
 * Create default story statuses for a project
 */
export async function createDefaultStoryStatuses(projectId: string) {
	return await db.projectStoryStatus.createMany({
		data: DEFAULT_STORY_STATUSES.map((status) => ({
			projectId,
			...status,
		})),
	});
}

/**
 * List story statuses for a project
 */
export async function listStoryStatuses(projectId: string) {
	return await db.projectStoryStatus.findMany({
		where: { projectId },
		orderBy: { order: "asc" },
	});
}

/**
 * Create a custom story status
 */
export async function createStoryStatus(data: {
	projectId: string;
	name: string;
	color: string;
	order: number;
	isDefault?: boolean;
	isFinal?: boolean;
}) {
	// If setting as default, unset other defaults first
	if (data.isDefault) {
		await db.projectStoryStatus.updateMany({
			where: { projectId: data.projectId, isDefault: true },
			data: { isDefault: false },
		});
	}

	return await db.projectStoryStatus.create({
		data: {
			projectId: data.projectId,
			name: data.name,
			color: data.color,
			order: data.order,
			isDefault: data.isDefault ?? false,
			isFinal: data.isFinal ?? false,
		},
	});
}

/**
 * Update a story status
 */
export async function updateStoryStatus(
	statusId: string,
	projectId: string,
	data: {
		name?: string;
		color?: string;
		order?: number;
		isDefault?: boolean;
		isFinal?: boolean;
	},
) {
	// If setting as default, unset other defaults first
	if (data.isDefault) {
		await db.projectStoryStatus.updateMany({
			where: { projectId, isDefault: true, id: { not: statusId } },
			data: { isDefault: false },
		});
	}

	return await db.projectStoryStatus.update({
		where: { id: statusId, projectId },
		data,
	});
}

/**
 * Delete a story status (moves stories to default status first).
 * If deleting the default status, assigns another status as default first.
 */
export async function deleteStoryStatus(
	statusId: string,
	projectId: string,
	editContext: StoryEditContext,
) {
	return await db.$transaction(async (tx) => {
		// Serialize status deletion within a project. Without this lock, two
		// concurrent deletes can both choose a status the other transaction removes.
		await tx.$queryRaw`
			SELECT "id"
			FROM "project_story_status"
			WHERE "projectId" = ${projectId}
			ORDER BY "id"
			FOR UPDATE
		`;

		const statuses = await tx.projectStoryStatus.findMany({
			where: { projectId },
			orderBy: { order: "asc" },
		});

		if (statuses.length <= 1) {
			throw new Error(
				"Cannot delete the last column. A project must have at least one column.",
			);
		}

		const toDelete = statuses.find((s) => s.id === statusId);
		if (!toDelete) {
			throw new Error("Status not found");
		}

		let defaultStatus = statuses.find((s) => s.isDefault);

		// If we're deleting the default, assign a new default first
		if (defaultStatus?.id === statusId) {
			const newDefault = statuses.find((s) => s.id !== statusId);
			if (!newDefault) {
				throw new Error("Cannot delete the last column");
			}
			await tx.projectStoryStatus.update({
				where: { id: newDefault.id, projectId },
				data: { isDefault: true },
			});
			defaultStatus = newDefault;
		} else if (!defaultStatus) {
			// Fallback: use first non-deleted status
			defaultStatus = statuses.find((s) => s.id !== statusId);
			if (!defaultStatus) {
				throw new Error(
					"Cannot delete status: no default status found",
				);
			}
			await tx.projectStoryStatus.update({
				where: { id: defaultStatus.id, projectId },
				data: { isDefault: true },
			});
		}

		const changedAt = new Date();
		await tx.userStory.updateMany({
			where: { statusId, projectId },
			data: {
				statusId: defaultStatus.id,
				lastEditedAt: changedAt,
				lastEditedByName: editContext.lastEditedByName ?? null,
				lastEditedSource: editContext.lastEditedSource,
			},
		});

		return await tx.projectStoryStatus.delete({
			where: { id: statusId, projectId },
		});
	});
}

/**
 * Reorder story statuses
 */
export async function reorderStoryStatuses(
	projectId: string,
	statusOrders: { id: string; order: number }[],
) {
	return await db.$transaction(
		statusOrders.map(({ id, order }) =>
			db.projectStoryStatus.update({
				where: { id, projectId },
				data: { order },
			}),
		),
	);
}

// ============================================================================
// User Story Queries
// ============================================================================

// `normalizeStoryIdentifierQuery` lives in its own DB-import-free file so
// client-side bundlers don't drag the Prisma client graph (pg, dns,
// @prisma/adapter-pg, ...) into the browser when client code imports it.
// Re-imported and re-exported here for backward compatibility with
// server-side callers AND so internal calls below can still use it.
import { normalizeStoryIdentifierQuery } from "./normalize-story-identifier-query";

export { normalizeStoryIdentifierQuery };

/**
 * Atomically allocate the next per-project story number.
 *
 * MUST be called inside the same transaction as the `userStory.create` that
 * consumes the result so the project row's `UPDATE ... RETURNING` serializes
 * concurrent writers on the project row — two callers racing to allocate the
 * same number will be ordered by Postgres' row lock on `project`, and the
 * `INSERT` into `user_story` is protected by the
 * `user_story_projectId_identifier_key` unique index as a defense-in-depth
 * backstop (spec 2026-05-21 §A3/§A4).
 *
 * Returns the allocated value as a plain decimal string (e.g., `"12"`,
 * `"137"`) — no zero-padding, no kind prefix (spec §A2). The DB column type
 * stays `String` so legacy `F-`/`B-`/`US-` identifiers continue to coexist
 * with the new format.
 *
 * Throws when the project row does not exist; callers should let this
 * propagate so the surrounding transaction rolls back cleanly.
 */
export async function allocateNextStoryNumber(
	tx: Prisma.TransactionClient,
	projectId: string,
): Promise<string> {
	const rows = await tx.$queryRaw<Array<{ allocated: number }>>`
		UPDATE "project"
		   SET "next_story_number" = "next_story_number" + 1
		 WHERE "id" = ${projectId}
		 RETURNING ("next_story_number" - 1)::int AS allocated
	`;
	const allocated = rows[0]?.allocated;
	if (allocated == null) {
		throw new Error(
			`Project ${projectId} not found when allocating story identifier`,
		);
	}
	return String(allocated);
}

/**
 * List user stories for a project
 */
export async function listStories(options: {
	projectId: string;
	statusId?: string;
	priority?: StoryPriority;
	draftingStage?: FeatureDraftingStage;
	assigneeId?: string;
	/**
	 * Work-item type filter (FEATURE / BUG). Omit to return BOTH — bugs have
	 * always been part of this result set; the filter just makes the split
	 * addressable for callers that want one or the other.
	 */
	kind?: StoryKind;
	search?: string;
	limit?: number;
	offset?: number;
	includeTaskCount?: boolean;
}) {
	const {
		projectId,
		statusId,
		priority,
		draftingStage,
		assigneeId,
		kind,
		search,
		limit = 100,
		offset = 0,
		includeTaskCount = true,
	} = options;

	// Normalize legacy prefixes (`F-`/`B-`/`US-`/`TASK-`) off the user's search
	// query so a paste of `B-011` matches both legacy `B-011` rows AND new
	// plain-numeric `11` rows. Apply BOTH the raw and the normalized form to
	// the identifier haystack via `OR` — the raw form preserves matches for
	// legacy prefixed values, the normalized form catches new values. Title
	// and description stay matched against the raw needle only (spec
	// 2026-05-21 §7.4).
	const normalizedSearch = search
		? normalizeStoryIdentifierQuery(search)
		: undefined;
	const where: Prisma.UserStoryWhereInput = {
		projectId,
		...(statusId ? { statusId } : {}),
		...(priority ? { priority } : {}),
		...(draftingStage ? { draftingStage } : {}),
		...(assigneeId ? { assigneeId } : {}),
		...(kind ? { kind } : {}),
		...(search
			? {
					OR: [
						{ title: { contains: search, mode: "insensitive" } },
						{
							description: {
								contains: search,
								mode: "insensitive",
							},
						},
						{
							identifier: {
								contains: search,
								mode: "insensitive",
							},
						},
						...(normalizedSearch && normalizedSearch !== search
							? [
									{
										identifier: {
											contains: normalizedSearch,
											mode: "insensitive" as const,
										},
									},
								]
							: []),
					],
				}
			: {}),
	};

	const [stories, total] = await Promise.all([
		db.userStory.findMany({
			where,
			include: {
				status: true,
				tasks: {
					orderBy: { order: "asc" },
					include: {
						subtasks: {
							orderBy: { order: "asc" },
						},
					},
				},
				...(includeTaskCount
					? {
							_count: {
								select: { tasks: true },
							},
						}
					: {}),
			},
			orderBy: [{ statusId: "asc" }, { order: "asc" }],
			take: limit,
			skip: offset,
		}),
		db.userStory.count({ where }),
	]);

	return { stories, total };
}

/**
 * Get stories grouped by status (for Kanban board)
 *
 * Returns the full UserStory model, `labels` included. Consumers that serve a
 * user- or agent-facing payload strip it at their own boundary (list-stories.ts);
 * see getStoryById for why narrowing it away here would be unsafe.
 */
export async function getStoriesForKanban(projectId: string) {
	const [statuses, stories] = await Promise.all([
		db.projectStoryStatus.findMany({
			where: { projectId },
			orderBy: { order: "asc" },
		}),
		db.userStory.findMany({
			where: { projectId },
			include: {
				status: true,
				tags: {
					select: { id: true, value: true, createdById: true },
				},
				tasks: {
					orderBy: { order: "asc" },
					include: {
						subtasks: {
							orderBy: { order: "asc" },
						},
						codingRuns: {
							take: 1,
							orderBy: { createdAt: "desc" as const },
							select: {
								id: true,
								executionChannel: true,
								provider: true,
								status: true,
								providerSessionId: true,
								pullRequestUrl: true,
								pullRequestNumber: true,
								externalUrl: true,
								externalStatus: true,
								providerMetadata: true,
								createdAt: true,
							},
						},
					},
				},
				codingRuns: {
					take: 1,
					orderBy: { createdAt: "desc" as const },
					select: {
						id: true,
						executionChannel: true,
						provider: true,
						status: true,
						providerSessionId: true,
						pullRequestUrl: true,
						pullRequestNumber: true,
						externalUrl: true,
						externalStatus: true,
						providerMetadata: true,
						storyTask: {
							select: {
								id: true,
								identifier: true,
								title: true,
							},
						},
						createdAt: true,
					},
				},
			},
			orderBy: { order: "asc" },
		}),
	]);

	return { statuses, stories };
}

/**
 * Shared include for the single-story reads below. Kept as a const so
 * getStoryByIdWithSourceMeeting can extend it without duplicating the body.
 */
const getStoryByIdInclude = {
	status: true,
	tags: {
		select: { id: true, value: true, createdById: true },
	},
	tasks: {
		orderBy: { order: "asc" },
		include: {
			subtasks: {
				orderBy: { order: "asc" },
			},
			codingRuns: {
				take: 1,
				orderBy: { createdAt: "desc" as const },
				select: {
					id: true,
					executionChannel: true,
					provider: true,
					status: true,
					providerSessionId: true,
					pullRequestUrl: true,
					pullRequestNumber: true,
					externalUrl: true,
					externalStatus: true,
					providerMetadata: true,
					createdAt: true,
				},
			},
		},
	},
	kanbanQueue: {
		take: 1,
		orderBy: { queuedAt: "desc" as const },
		select: {
			id: true,
			status: true,
			queuedAt: true,
			pulledAt: true,
			completedAt: true,
			branchName: true,
		},
	},
} satisfies Prisma.UserStoryInclude;

/**
 * Get a single user story by ID
 *
 * NEVER narrow this to omit `labels` (via `select`, or Prisma's `omit`, which
 * composes with `include` and so looks tempting). This query is the PM push's
 * label source: gitlab-rest-story-sync.ts reads `story.labels ?? []` to compute
 * the label delta and to full-set labels on the create path. Omitting the field
 * makes that read `[]`, which silently wipes every issue's GitLab labels on the
 * next push — and it type-checks. The sync tests mock this function, so they
 * would not catch it either. `labels` is stripped at the procedure boundary
 * instead — see `stripInternalStoryFields` in @repo/api's projects/lib, which
 * every story-returning procedure routes through.
 */
export async function getStoryById(storyId: string, projectId: string) {
	return await db.userStory.findFirst({
		where: { id: storyId, projectId },
		include: getStoryByIdInclude,
	});
}

/**
 * getStoryById plus the story's source-meeting provenance relation
 *. Kept as a separate variant — NOT part of the default
 * include — because several callers (v1 REST features, enhance-feature,
 * sync-story) return getStoryById's result unmodified, and adding the
 * relation there would leak the raw transcript row into their responses.
 * Only the story-detail read (get-story.ts) should use this; it maps the
 * relation onto a flat `sourceMeeting` shape and drops the raw row.
 */
export async function getStoryByIdWithSourceMeeting(
	storyId: string,
	projectId: string,
) {
	return await db.userStory.findFirst({
		where: { id: storyId, projectId },
		include: {
			...getStoryByIdInclude,
			sourceMeetingTranscript: {
				select: {
					meetingSubject: true,
					meetingDate: true,
					linkedMeeting: { select: { subject: true } },
				},
			},
		},
	});
}

/**
 * List stories for the bulk Markdown export procedure
 * (`projects.stories.createBatchDownloadUrl`).
 *
 * Filters by `projectId` AND `id IN storyIds` so the caller's tenant filter
 * (already validated upstream) drops any cross-tenant rows. The returned
 * shape is the minimum needed to render a feature export: identifier, title,
 * description, acceptance criteria, priority, size, drafting stage, and the
 * ordered list of tasks.
 */
export async function listStoriesForDownload(
	projectId: string,
	storyIds: string[],
) {
	if (storyIds.length === 0) {
		return [];
	}
	return await db.userStory.findMany({
		where: { projectId, id: { in: storyIds } },
		select: {
			id: true,
			identifier: true,
			title: true,
			description: true,
			acceptanceCriteria: true,
			priority: true,
			size: true,
			draftingStage: true,
			tasks: {
				orderBy: { order: "asc" },
				select: {
					id: true,
					identifier: true,
					title: true,
					isCompleted: true,
					order: true,
				},
			},
		},
	});
}

/**
 * Create a new user story
 */
export async function createStory(data: {
	projectId: string;
	statusId?: string;
	title: string;
	description?: string;
	acceptanceCriteria?: string;
	kind?: StoryKind;
	priority?: StoryPriority;
	size?: StorySize;
	storyPoints?: number;
	labels?: string[];
	createdById: string;
	assigneeId?: string;
	pipelineExecutionId?: string;
	draftingStage?: FeatureDraftingStage;
	source: StorySource;
	// F-171: bug triage flag (typically true at creation only when the bug
	// prompt's structured output says the report is too ambiguous to act on).
	needsMoreInfo?: boolean;
	// F-171: reporter tracking (REQ-8, REQ-9). Always populated for stories
	// created via manual UI; agent-initiated stories pass these when the
	// fabric_create_story tool provided source context.
	reporterName?: string | null;
	reporterSource?: ReporterSource | null;
	reporterSourceUrl?: string | null;
	// If you stamp `externalId` at create, you must also stamp
	// `pmAutoSyncEnabled: true` — see spec §4.2 / risk #6.
	pmAutoSyncEnabled?: boolean;
	externalId?: string;
	externalUrl?: string;
	// The PendingBacklogProposal this story came from. Passed by the
	// proposal-approval and AI Update apply paths so the provenance is written
	// in the same INSERT as the row itself (never a post-create stamp).
	createdFromProposalId?: string;
	// Failure-to-bug: the test case whose red pipeline result opened this
	// bug. Set only for source=PIPELINE_FAILURE; also the dedup key. Written in
	// the same INSERT so the link can never be missing.
	originTestCaseId?: string | null;
	// Machine-filed-bug dedup key (a hash of a normalized error signature).
	// Written in the same INSERT as the row so the partial unique index on
	// (projectId, bugFingerprint) WHERE non-terminal is the race backstop for
	// callers that check-then-create. Only the MCP gateway's fabric_create_bug
	// tool sets this today.
	bugFingerprint?: string | null;
}) {
	// Get default status if not provided. Status resolution stays outside the
	// allocator transaction so projects without seeded statuses don't deadlock
	// on the default-status bootstrap (`createDefaultStoryStatuses` runs
	// `projectStoryStatus.createMany`, which can't share a row lock with a
	// concurrent allocator UPDATE on `project`).
	let statusId = data.statusId;
	if (!statusId) {
		const defaultStatus = await db.projectStoryStatus.findFirst({
			where: { projectId: data.projectId, isDefault: true },
		});
		if (!defaultStatus) {
			// Create default statuses if none exist
			await createDefaultStoryStatuses(data.projectId);
			const newDefault = await db.projectStoryStatus.findFirst({
				where: { projectId: data.projectId, isDefault: true },
			});
			statusId = newDefault?.id;
		} else {
			statusId = defaultStatus.id;
		}
	}
	if (!statusId) {
		throw new Error("Default story status could not be resolved");
	}
	const resolvedStatusId = statusId;

	// Allocate the per-project identifier and INSERT the row inside a single
	// transaction so the `UPDATE "project" ... RETURNING` row lock and the
	// `userStory.create` commit together. This is the only safe way to make
	// 50-concurrent creates produce 50 distinct sequential identifiers — the
	// row lock on `project` serializes allocators and the partial unique index
	// on (projectId, identifier) is the defense-in-depth backstop.
	//
	// `maxWait` and `timeout` are bumped above Prisma's 2s / 5s defaults so a
	// deep queue of concurrent allocators (the 50-burst AC6 case) waiting on
	// the project row lock does not get cut off mid-flight with
	// "Transaction API error: Unable to start a transaction in the given time".
	const created = await db.$transaction(
		async (tx) => {
			const identifier = await allocateNextStoryNumber(
				tx,
				data.projectId,
			);

			// Get next order in column (inside the transaction so concurrent
			// creates in the same column don't both compute the same max+1).
			const lastStory = await tx.userStory.findFirst({
				where: {
					projectId: data.projectId,
					statusId: resolvedStatusId,
				},
				orderBy: { order: "desc" },
				select: { order: true },
			});
			const order = (lastStory?.order ?? 0) + 1;

			return tx.userStory.create({
				data: {
					projectId: data.projectId,
					statusId: resolvedStatusId,
					identifier,
					title: data.title,
					description: data.description,
					acceptanceCriteria: data.acceptanceCriteria,
					kind: data.kind ?? "FEATURE",
					priority: data.priority ?? "P2_MEDIUM",
					size: data.size,
					storyPoints: data.storyPoints,
					order,
					roadmapOrder: order, // Mirror initial order so roadmap also starts in creation order
					labels: data.labels ?? [],
					createdById: data.createdById,
					assigneeId: data.assigneeId,
					pipelineExecutionId: data.pipelineExecutionId,
					draftingStage: data.draftingStage ?? "PLACEHOLDER",
					source: data.source,
					needsMoreInfo: data.needsMoreInfo ?? false,
					reporterName: data.reporterName ?? null,
					reporterSource: data.reporterSource ?? null,
					reporterSourceUrl: data.reporterSourceUrl ?? null,
					// Forward only when caller opts in; omitting lets the Prisma column
					// default (`false`) apply so Fabric-only create paths stay local.
					...(data.pmAutoSyncEnabled !== undefined && {
						pmAutoSyncEnabled: data.pmAutoSyncEnabled,
					}),
					// External PM-tool link (GitLab/Fizzy/Linear). Set only when
					// provided so Fabric-only create paths leave these null. Combined
					// with the partial unique index on (projectId, externalId) this
					// lets the caller insert the link atomically (see Task 5).
					...(data.externalId !== undefined && {
						externalId: data.externalId,
					}),
					...(data.externalUrl !== undefined && {
						externalUrl: data.externalUrl,
					}),
					// Proposal provenance, written in the same INSERT so a
					// created story can never be missing its link. Omitted for
					// callers that have no proposal, leaving the column null.
					...(data.createdFromProposalId !== undefined && {
						createdFromProposalId: data.createdFromProposalId,
					}),
					// RCA→BUG link, written in the same INSERT.
					...(data.originTestCaseId != null && {
						originTestCaseId: data.originTestCaseId,
					}),
					// Machine-filed-bug dedup key, written in the same INSERT so
					// the partial unique index can reject a racing duplicate
					// instead of letting one land un-fingerprinted.
					...(data.bugFingerprint != null && {
						bugFingerprint: data.bugFingerprint,
					}),
				},
				include: {
					status: true,
					tasks: true,
				},
			});
		},
		{
			maxWait: 15_000,
			timeout: 30_000,
		},
	);

	// Persist a "View in Fabric" back-link in the story's description so it
	// rides along to any external PM tool on push, and so users browsing
	// the story in Fabric have a stable canonical link. Idempotent: skip
	// when the description already contains "View in Fabric". Best-effort:
	// failure to compute or persist the link must NOT fail story creation.
	try {
		const project = await db.project.findUnique({
			where: { id: data.projectId },
			select: { organizationId: true },
		});
		const fabricUrl = await buildFabricStoryUrl({
			projectId: data.projectId,
			storyId: created.id,
			organizationId: project?.organizationId,
		});
		const placed = placeFabricBackLink({
			description: created.description,
			acceptanceCriteria: created.acceptanceCriteria,
			fabricUrl,
		});
		const descriptionChanged =
			placed.description !== (created.description ?? "");
		const acceptanceCriteriaChanged =
			placed.acceptanceCriteria !== (created.acceptanceCriteria ?? null);
		if (descriptionChanged || acceptanceCriteriaChanged) {
			return await db.userStory.update({
				where: { id: created.id },
				data: {
					description: placed.description,
					acceptanceCriteria: placed.acceptanceCriteria,
				},
				include: {
					status: true,
					tasks: true,
				},
			});
		}
	} catch (e) {
		// Soft-fail — story is already created; back-link append is opportunistic.
		console.warn("[createStory] Failed to persist Fabric back-link", {
			error: e,
			storyId: created.id,
		});
	}

	return created;
}

/**
 * Update a user story
 */
export type UpdateStoryData = {
	title?: string;
	description?: string | null;
	acceptanceCriteria?: string | null;
	priority?: StoryPriority;
	size?: StorySize | null;
	storyPoints?: number | null;
	labels?: string[];
	assigneeId?: string | null;
	statusId?: string;
	externalId?: string | null;
	externalUrl?: string | null;
	externalMcpServerId?: string | null;
	lastSyncedStatusId?: string | null;
	draftingStage?: FeatureDraftingStage;
	maturationStatus?: MaturationStatus | null;
	coverageOverrideReason?: string;
	coverageOverrideById?: string;
	coverageOverrideAt?: Date;
	kind?: StoryKind;
	needsMoreInfo?: boolean;
	pmAutoSyncEnabled?: boolean;
};

export type StoryEditContext = {
	lastEditedByName?: string | null;
	lastEditedSource: LastEditSource;
};

type GenuineEditStoryState = {
	title: string;
	description: string | null;
	acceptanceCriteria: string | null;
	priority: StoryPriority;
	size: StorySize | null;
	storyPoints: number | null;
	labels: string[];
	assigneeId: string | null;
	statusId: string;
	draftingStage: FeatureDraftingStage;
	maturationStatus: MaturationStatus | null;
	kind: StoryKind;
	needsMoreInfo: boolean;
	coverageOverrideReason: string | null;
	coverageOverrideById: string | null;
	coverageOverrideAt: Date | null;
};

function optionalValueChanged<T>(next: T | undefined, current: T): boolean {
	return next !== undefined && !Object.is(next, current);
}

function optionalDateChanged(
	next: Date | undefined,
	current: Date | null,
): boolean {
	return next !== undefined && next.getTime() !== current?.getTime();
}

/**
 * Labels are a SET, so order is not a change. PM tools do not guarantee a stable
 * label order between polls, and comparing by index would let a pull that
 * changed nothing stamp an edit purely because the upstream tool listed the same
 * labels differently.
 */
function optionalStringArrayChanged(
	next: string[] | undefined,
	current: string[],
): boolean {
	if (next === undefined) {
		return false;
	}
	if (next.length !== current.length) {
		return true;
	}
	const remaining = new Map<string, number>();
	for (const value of current) {
		remaining.set(value, (remaining.get(value) ?? 0) + 1);
	}
	for (const value of next) {
		const count = remaining.get(value);
		if (count === undefined) {
			return true;
		}
		if (count === 1) {
			remaining.delete(value);
		} else {
			remaining.set(value, count - 1);
		}
	}
	return remaining.size > 0;
}

/** Bind one classified field to the comparator that decides if it moved. */
function comparesField<K extends keyof GenuineEditStoryState>(
	field: K,
	changed: (
		next: UpdateStoryData[K],
		current: GenuineEditStoryState[K],
	) => boolean,
) {
	return (current: GenuineEditStoryState, next: UpdateStoryData) =>
		changed(next[field], current[field]);
}

/**
 * One comparator per field that counts as a genuine edit. The mapped type is
 * the point: a field added to `GenuineEditStoryState` with no entry here fails
 * to compile, so the classifier cannot silently fall behind the state it
 * guards — and a field it stops classifying is a field whose changes stop
 * moving the story's edit clock, which is the exact defect this whole change
 * exists to remove. Operational PM-link and sync fields are deliberately absent.
 *
 * This governs the `updateStory` path only. Three sibling writers in this file
 * stamp the edit event on their own terms — `deleteStoryStatus` (every story it
 * reassigns), `moveStory` (only when the status actually changes), and
 * `updateStoryDraftingStage` (past its own no-op guard) — so this is not the
 * only place `lastEditedAt` is written.
 */
const GENUINE_EDIT_COMPARATORS: {
	[K in keyof GenuineEditStoryState]: (
		current: GenuineEditStoryState,
		next: UpdateStoryData,
	) => boolean;
} = {
	title: comparesField("title", optionalValueChanged),
	description: comparesField("description", optionalValueChanged),
	acceptanceCriteria: comparesField(
		"acceptanceCriteria",
		optionalValueChanged,
	),
	priority: comparesField("priority", optionalValueChanged),
	size: comparesField("size", optionalValueChanged),
	storyPoints: comparesField("storyPoints", optionalValueChanged),
	labels: comparesField("labels", optionalStringArrayChanged),
	assigneeId: comparesField("assigneeId", optionalValueChanged),
	statusId: comparesField("statusId", optionalValueChanged),
	draftingStage: comparesField("draftingStage", optionalValueChanged),
	maturationStatus: comparesField("maturationStatus", optionalValueChanged),
	kind: comparesField("kind", optionalValueChanged),
	needsMoreInfo: comparesField("needsMoreInfo", optionalValueChanged),
	coverageOverrideReason: comparesField(
		"coverageOverrideReason",
		optionalValueChanged,
	),
	coverageOverrideById: comparesField(
		"coverageOverrideById",
		optionalValueChanged,
	),
	coverageOverrideAt: comparesField(
		"coverageOverrideAt",
		optionalDateChanged,
	),
};

/**
 * Decide whether an update changes canonical, user-visible ticket state.
 */
export function hasGenuineStoryEdit(
	current: GenuineEditStoryState,
	next: UpdateStoryData,
): boolean {
	return Object.values(GENUINE_EDIT_COMPARATORS).some((changed) =>
		changed(current, next),
	);
}

/**
 * Provenance + concurrency context for a story update. Named so the locked
 * read-modify-write wrapper below can take exactly what `updateStory` takes.
 */
export type UpdateStoryVersionContext = {
	userId?: string;
	organizationId?: string;
	changedBy?: string;
	changeDescription?: string;
	/** When set, the update will fail if the story's current version doesn't match. */
	expectedVersion?: number;
	/** Semantic edit context. The database supplies the timestamp only after
	 * proving that one of the classified canonical fields changed. */
	lastEditedByName?: string | null;
	lastEditedSource?: LastEditSource;
	/**
	 * Provenance for the priority-band history row this update writes when
	 * `data.priority` actually moves. Defaults to MANUAL — the AI paths
	 * (AI Update apply, re-prioritization) pass "AI" and, where they have
	 * one, the rationale behind the move.
	 */
	prioritySource?: PriorityChangeSource;
	priorityReason?: string | null;
};

export async function updateStory(
	storyId: string,
	projectId: string,
	data: UpdateStoryData,
	versionContext?: UpdateStoryVersionContext,
	// Optional Prisma transaction client. When supplied, the read, the guarded
	// write and the version snapshot all run inside the CALLER's transaction —
	// so a caller that must read-modify-write under a row lock (see
	// `updateStoryDescriptionUnderLock`) can hold that lock across both halves
	// instead of racing between them. When omitted this self-transacts exactly
	// as before, so every existing caller is unchanged. Mirrors the optional-`tx`
	// shape already used by `updateStoryDraftingStage`.
	existingTx?: Prisma.TransactionClient,
) {
	const run = async (tx: Prisma.TransactionClient) => {
		const currentStory = await tx.userStory.findUnique({
			where: { id: storyId, projectId },
			select: {
				updatedAt: true,
				// The optimistic-concurrency token for the non-version branch.
				lastEditedAt: true,
				version: true,
				title: true,
				description: true,
				acceptanceCriteria: true,
				size: true,
				storyPoints: true,
				labels: true,
				assigneeId: true,
				statusId: true,
				draftingStage: true,
				maturationStatus: true,
				kind: true,
				needsMoreInfo: true,
				coverageOverrideReason: true,
				coverageOverrideById: true,
				coverageOverrideAt: true,
				priority: true,
				roadmapOrder: true,
				externalId: true,
				externalMcpServerId: true,
			},
		});

		if (!currentStory) {
			throw new Error("Story not found");
		}

		const descriptionChanged =
			data.description !== undefined &&
			data.description !== currentStory.description;
		const acceptanceCriteriaChanged =
			data.acceptanceCriteria !== undefined &&
			data.acceptanceCriteria !== currentStory.acceptanceCriteria;
		const draftingStageChanged =
			data.draftingStage !== undefined &&
			data.draftingStage !== currentStory.draftingStage;
		const kindChanged =
			data.kind !== undefined && data.kind !== currentStory.kind;

		const genuineEditChanged = hasGenuineStoryEdit(currentStory, data);
		if (
			genuineEditChanged &&
			versionContext?.lastEditedSource === undefined
		) {
			throw new Error("Genuine story edits require last-edit context");
		}
		const stampLastEdited =
			genuineEditChanged &&
			versionContext?.lastEditedSource !== undefined;
		const lastEditedAt = stampLastEdited ? new Date() : undefined;

		/**
		 * `kind` counts (Fizzy #2048). A kind change is material: it selects which
		 * prompt every future AI action writing this body runs, so the row before
		 * it is worth a snapshot.
		 *
		 * It is also load-bearing for the conversion redraft's stale-write guard.
		 * That guard writes under `expectedVersion`, and its whole premise is that
		 * a second conversion moves the version on. Without `kindChanged` it does
		 * not: converting an item already sitting in DRAFT — which every bug is —
		 * changes only `kind`, and the stage snaps DRAFT to DRAFT. Two toggles
		 * would then leave the version untouched, an in-flight redraft's
		 * `expectedVersion` would still match, and it would land its old-type body
		 * over the new type. That is the exact cross-type bleed the ticket exists
		 * to close.
		 */
		const shouldCreateVersion =
			descriptionChanged ||
			acceptanceCriteriaChanged ||
			draftingStageChanged ||
			kindChanged;

		const linkIdentityChanged =
			(data.externalId !== undefined &&
				data.externalId !== currentStory.externalId) ||
			(data.externalMcpServerId !== undefined &&
				data.externalMcpServerId !== currentStory.externalMcpServerId);

		// Relink/re-tool/manual-unlink: stale FLAG_MISSING state must not bleed
		// into the new link (#1360). Clears streaks and supersedes any PENDING
		// FLAG_MISSING row for this story. Runs in BOTH updateStory write paths.
		const clearStaleMissingState = async () => {
			await tx.pmTicketMissingStreak.deleteMany({
				where: { projectId, entityType: "STORY", entityId: storyId },
			});
			await tx.pendingPmStateChange.updateMany({
				where: {
					projectId,
					entityType: "STORY",
					entityId: storyId,
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				},
				data: { status: "DISMISSED" },
			});
		};

		// One timestamp for the band move, shared by the story's denormalised
		// stamp and its history row so the two can never disagree.
		const priorityChangedAt = lastEditedAt ?? new Date();

		// Priority change → rebase roadmapOrder to the bottom of the new bucket,
		// inside the same transaction so the max read and the write are atomic
		// per request. Read Committed allows two concurrent rebases to compute
		// the same max+1; the duplicate is resolved by the client-side id
		// tiebreaker (see roadmap-utils.ts / roadmap-sorts.ts).
		// The band moved, so rebase its roadmap rank AND record the change.
		// Handled HERE — inside updateStory, in the same transaction as the
		// field itself — rather than in any one caller, because `priority`
		// reaches this function from the work-item form, the public v1 API and
		// the AI Update apply path. Doing it at the single write point is what
		// makes "every priority change has a history entry" true by
		// construction rather than by every caller remembering. An update that
		// does not move the band does neither.
		let priorityRebaseOrder: number | undefined;
		if (
			data.priority !== undefined &&
			data.priority !== currentStory.priority
		) {
			const move = await recordPriorityMove(tx, {
				storyId,
				projectId,
				fromPriority: currentStory.priority,
				toPriority: data.priority,
				source: versionContext?.prioritySource ?? "MANUAL",
				reason: versionContext?.priorityReason,
				actorId: versionContext?.changedBy ?? versionContext?.userId,
				actorName: versionContext?.lastEditedByName,
				changedAt: priorityChangedAt,
			});
			priorityRebaseOrder = move.roadmapOrder;
		}

		// Automatically set draftingStageUpdatedAt when draftingStage changes
		const writeData = {
			...(draftingStageChanged
				? {
						...data,
						draftingStageUpdatedAt: lastEditedAt ?? new Date(),
					}
				: data),
			...(priorityRebaseOrder !== undefined
				? {
						roadmapOrder: priorityRebaseOrder,
						priorityChangedAt,
						// Mirror the change's rationale for the inline row "why".
						priorityChangeReason:
							versionContext?.priorityReason?.trim() || null,
					}
				: {}),
			...(draftingStageChanged ? { pmAutoHidden: false } : {}),
			...(stampLastEdited
				? {
						lastEditedAt,
						lastEditedByName:
							versionContext?.lastEditedByName ?? null,
						lastEditedSource: versionContext?.lastEditedSource,
					}
				: {}),
		};

		if (!shouldCreateVersion) {
			const updatedCount = await tx.userStory.updateMany({
				where: {
					id: storyId,
					projectId,
					// Guard only a write that is itself an edit, and guard it
					// with the semantic edit clock.
					//
					// `updatedAt` is wrong as a token: it moves on derived
					// writes (summary seeding, scan hashes), so background work
					// landing mid-transaction fails a legitimate save.
					// `version` is also wrong: this branch never advances it, so
					// the predicate could never fail and two concurrent edits
					// silently overwrote each other.
					//
					// An operational write — a PM link stamp, sync bookkeeping —
					// is uncontended and carries no user intent, so it must not
					// fail merely because somebody edited the story in the same
					// instant. Several such callers do not guard the throw.
					...(stampLastEdited
						? { lastEditedAt: currentStory.lastEditedAt }
						: {}),
				},
				data: writeData,
			});
			if (updatedCount.count === 0) {
				throw new StoryVersionConflictError(storyId);
			}
			if (linkIdentityChanged) {
				await clearStaleMissingState();
			}
			const updated = await tx.userStory.findUnique({
				where: { id: storyId, projectId },
				include: {
					status: true,
					tasks: { orderBy: { order: "asc" } },
				},
			});
			if (!updated) {
				throw new Error("Story not found after update");
			}
			return updated;
		}

		const currentVersion = currentStory.version ?? 1;

		// When an expected version is provided (e.g. from a preview/apply flow),
		// verify it matches before writing — this closes the TOCTOU gap.
		if (
			versionContext?.expectedVersion !== undefined &&
			currentVersion !== versionContext.expectedVersion
		) {
			throw new StoryVersionConflictError(storyId);
		}

		// Optimistic concurrency guard: only update if version is unchanged.
		const updatedCount = await tx.userStory.updateMany({
			where: { id: storyId, projectId, version: currentVersion },
			data: {
				...writeData,
				version: { increment: 1 },
			},
		});

		if (updatedCount.count === 0) {
			throw new StoryVersionConflictError(storyId);
		}

		if (linkIdentityChanged) {
			await clearStaleMissingState();
		}

		await tx.featureVersion.createMany({
			data: [
				{
					storyId,
					version: currentVersion,
					description: currentStory.description,
					acceptanceCriteria: currentStory.acceptanceCriteria,
					draftingStage: currentStory.draftingStage,
					changeDescription:
						versionContext?.changeDescription ?? null,
					changedBy: versionContext?.changedBy ?? null,
					userId: versionContext?.userId ?? null,
					organizationId: versionContext?.organizationId ?? null,
				},
			],
			skipDuplicates: true,
		});

		const updatedStory = await tx.userStory.findUnique({
			where: { id: storyId, projectId },
			include: {
				status: true,
				tasks: {
					orderBy: { order: "asc" },
				},
			},
		});

		if (!updatedStory) {
			throw new Error("Story not found after update");
		}

		return updatedStory;
	};

	return existingTx ? await run(existingTx) : await db.$transaction(run);
}

/**
 * Rewrite a story's `description` from the value the row holds RIGHT NOW, with
 * the read and the write in ONE transaction whose FIRST statement takes the
 * row's `FOR UPDATE` lock (same shape as `deleteStoryStatus` /
 * `clearProjectStories`).
 *
 * Both halves are load-bearing for an append-style rewrite:
 *
 *   - Reading the description OUTSIDE the write's transaction is how two
 *     near-simultaneous appends both compute against the same base text; the
 *     later write then wins and the earlier append is silently gone.
 *   - Reading inside the transaction but WITHOUT the lock does not fix it.
 *     Under Read Committed the second transaction still reads pre-append text,
 *     `updateStory`'s compare-and-set then matches zero rows and throws
 *     `StoryVersionConflictError`. That turns silent loss into detected loss —
 *     an improvement, but the append is still lost. The lock is what makes the
 *     second writer BLOCK until the first commits and then compute against the
 *     committed result.
 *
 * TENANT ISOLATION: the lock, the read and the write each pair the story id
 * with the project id. The lock predicate is ADDED to that pairing, never
 * substituted for it — locking on `id` alone would hand a caller scoped to a
 * different project a row it must not see.
 *
 * `computeDescription` must be PURE and cheap: it runs while the row lock is
 * held, so any IO inside it extends the hold time for every queued writer.
 */
export async function updateStoryDescriptionUnderLock(
	storyId: string,
	projectId: string,
	computeDescription: (currentDescription: string | null) => string,
	versionContext: UpdateStoryVersionContext,
) {
	return await db.$transaction(async (tx) => {
		// Prisma has no `FOR UPDATE` on findUnique, so the lock is raw SQL. It is
		// this transaction's first statement — taking it after the read would
		// leave the exact window it exists to close.
		await tx.$queryRaw`SELECT "id" FROM "user_story" WHERE "id" = ${storyId} AND "projectId" = ${projectId} FOR UPDATE`;

		const current = await tx.userStory.findUnique({
			where: { id: storyId, projectId },
			select: { description: true },
		});
		if (!current) {
			throw new Error("Story not found");
		}

		return await updateStory(
			storyId,
			projectId,
			{ description: computeDescription(current.description) },
			versionContext,
			tx,
		);
	});
}

/**
 * Move a story to a different status column
 */
export async function moveStory(
	storyId: string,
	projectId: string,
	newStatusId: string,
	newOrder: number | undefined,
	editContext: StoryEditContext,
) {
	return db.$transaction(async (tx) => {
		const currentStory = await tx.userStory.findUnique({
			where: { id: storyId, projectId },
			select: { statusId: true, lastEditedAt: true },
		});
		if (!currentStory) {
			throw new Error("Story not found");
		}

		let order = newOrder;
		if (order === undefined) {
			const lastStory = await tx.userStory.findFirst({
				where: { projectId, statusId: newStatusId },
				orderBy: { order: "desc" },
				select: { order: true },
			});
			order = (lastStory?.order ?? 0) + 1;
		}

		const statusChanged = currentStory.statusId !== newStatusId;
		const updatedCount = await tx.userStory.updateMany({
			where: {
				id: storyId,
				projectId,
				// Only a lane change is an edit; a same-lane reorder is not,
				// and drag-and-drop must not fail because someone edited the
				// story at that moment. See updateStory for why the token is
				// the edit clock rather than `updatedAt` or `version`.
				...(statusChanged
					? { lastEditedAt: currentStory.lastEditedAt }
					: {}),
			},
			data: {
				statusId: newStatusId,
				order,
				...(statusChanged
					? {
							lastEditedAt: new Date(),
							lastEditedByName:
								editContext.lastEditedByName ?? null,
							lastEditedSource: editContext.lastEditedSource,
						}
					: {}),
			},
		});
		if (updatedCount.count === 0) {
			throw new StoryVersionConflictError(storyId);
		}

		const updated = await tx.userStory.findUnique({
			where: { id: storyId, projectId },
			include: {
				status: true,
				tasks: true,
			},
		});
		if (!updated) {
			throw new Error("Story not found after update");
		}
		return updated;
	});
}

/**
 * Reorder stories within a column
 */
export async function reorderStories(
	projectId: string,
	storyOrders: { id: string; order: number }[],
) {
	return await db.$transaction(
		storyOrders.map(({ id, order }) =>
			db.userStory.update({
				where: { id, projectId },
				data: { order },
			}),
		),
	);
}

/**
 * Reorder stories within a Roadmap priority bucket.
 * Updates roadmapOrder only — never touches the Kanban `order` field.
 */
export async function reorderStoriesRoadmap(
	projectId: string,
	storyOrders: { id: string; roadmapOrder: number }[],
) {
	return await db.$transaction(
		storyOrders.map(({ id, roadmapOrder }) =>
			db.userStory.update({
				where: { id, projectId },
				data: { roadmapOrder },
			}),
		),
	);
}

/**
 * Write the shared manual rank used by the roadmap's Priority layout.
 *
 * Raw SQL on purpose: a Prisma `update` trips the model's `@updatedAt`, which
 * would reset "last updated" on every peer a single drag touched. Reordering is
 * a presentation change, not a content edit — same reasoning as `moveRoadmap`.
 * The `projectId` predicate is part of every statement, so an id from another
 * project simply matches nothing.
 */
export async function reorderStoriesPriority(
	projectId: string,
	storyOrders: { id: string; priorityOrder: number }[],
) {
	if (storyOrders.length === 0) {
		return;
	}

	// One statement, not one per row: a drag pins the whole visible sequence, so
	// the per-row form issued a round trip per work item and held locks on all of
	// them for the duration. A VALUES join keeps the raw-SQL rationale above while
	// making the cost independent of backlog size.
	const values = Prisma.join(
		storyOrders.map(
			({ id, priorityOrder }) =>
				Prisma.sql`(${id}, ${priorityOrder}::double precision)`,
		),
	);

	await db.$executeRaw`
		UPDATE "user_story" AS s
		SET "priorityOrder" = v."order"
		FROM (VALUES ${values}) AS v(id, "order")
		WHERE s."id" = v.id AND s."projectId" = ${projectId}`;
}

/**
 * Drop every manual rank for one work-item kind, restoring the computed order.
 * Scoped to a single kind because the Priority layout ranks bugs and features
 * independently — resetting one must not disturb the other. Returns the number
 * of rows actually cleared.
 */
export async function clearStoriesPriorityOrder(
	projectId: string,
	kind: StoryKind,
): Promise<number> {
	return await db.$executeRaw`
		UPDATE "user_story"
		SET "priorityOrder" = NULL
		WHERE "projectId" = ${projectId}
		  AND "kind" = ${kind}::"StoryKind"
		  AND "priorityOrder" IS NOT NULL`;
}

/**
 * Update a feature's drafting stage
 *
 * Writes a `FeatureVersion` snapshot when the stage actually changes so the
 * transition is auditable. If the target stage matches the current stage,
 * the write is a no-op (no version row, no timestamp churn) and the current
 * story shape is returned unchanged.
 */
export async function updateStoryDraftingStage(
	storyId: string,
	projectId: string,
	stage: FeatureDraftingStage,
	versionContext: {
		userId?: string;
		organizationId?: string;
		changedBy?: string;
		changeDescription?: string;
		lastEditedByName?: string | null;
		lastEditedSource: LastEditSource;
	},
	// Optional Prisma transaction client. When supplied, the read / version
	// snapshot / stage update run against the caller's transaction — so a
	// multi-step operation (e.g. a duplicate merge that re-parents tasks and
	// transfers a PM link) can retire the story ATOMICALLY with the rest of its
	// writes. When omitted, this self-transacts exactly as before, so every
	// existing caller is unchanged.
	tx?: Prisma.TransactionClient,
) {
	const run = async (client: Prisma.TransactionClient) => {
		const currentStory = await client.userStory.findUnique({
			where: { id: storyId, projectId },
			include: {
				status: true,
				tasks: {
					orderBy: { order: "asc" },
				},
			},
		});

		if (!currentStory) {
			throw new Error("Story not found");
		}

		// No-op: stage unchanged. Skip the version write and the update.
		if (currentStory.draftingStage === stage) {
			return currentStory;
		}

		await client.featureVersion.createMany({
			data: [
				{
					storyId,
					version: currentStory.version ?? 1,
					description: currentStory.description,
					acceptanceCriteria: currentStory.acceptanceCriteria,
					draftingStage: currentStory.draftingStage,
					changeDescription:
						versionContext?.changeDescription ?? null,
					changedBy: versionContext?.changedBy ?? null,
					userId: versionContext?.userId ?? null,
					organizationId: versionContext?.organizationId ?? null,
				},
			],
			skipDuplicates: true,
		});

		const changedAt = new Date();
		const updatedCount = await client.userStory.updateMany({
			where: {
				id: storyId,
				projectId,
				// Concurrency token is the semantic edit clock: `updatedAt`
				// moves on derived writes and would fail a legitimate save,
				// while `version` is not advanced by this write so it could
				// never fail at all. See updateStory for the full reasoning.
				lastEditedAt: currentStory.lastEditedAt,
			},
			data: {
				draftingStage: stage,
				draftingStageUpdatedAt: changedAt,
				pmAutoHidden: false,
				lastEditedAt: changedAt,
				lastEditedByName: versionContext.lastEditedByName ?? null,
				lastEditedSource: versionContext.lastEditedSource,
			},
		});
		if (updatedCount.count === 0) {
			throw new StoryVersionConflictError(storyId);
		}
		const updated = await client.userStory.findUnique({
			where: { id: storyId, projectId },
			include: {
				status: true,
				tasks: {
					orderBy: { order: "asc" },
				},
			},
		});
		if (!updated) {
			throw new Error("Story not found after update");
		}
		return updated;
	};

	return tx ? await run(tx) : await db.$transaction(run);
}

/**
 * Delete a user story
 *
 * Also removes every Document-Assistant chat history attached to this
 * story (when the assistant was mounted in the feature-edit view).
 * `DocumentAssistantConversation.documentRefId` is polymorphic (no
 * single FK) so the cascade has to live here at the query layer.
 * Deleting the underlying `AgentConversation` rows lets the existing
 * `onDelete: Cascade` on the join table remove the join rows.
 *
 * spec §3.9 FR-24 — keeping orphan AI history is more confusing than
 * useful; see release notes.
 */
export async function deleteStory(storyId: string, projectId: string) {
	return await db.$transaction(async (tx) => {
		const attachments = await tx.documentAssistantConversation.findMany({
			where: {
				documentRefKind: "USER_STORY",
				documentRefId: storyId,
			},
			select: { conversationId: true },
		});

		if (attachments.length > 0) {
			await tx.agentConversation.deleteMany({
				where: { id: { in: attachments.map((a) => a.conversationId) } },
			});
		}

		// Polymorphic cleanup: Subscription has no FK to the subject (subjectId
		// is an untyped pointer), so watch rows must be removed explicitly.
		await tx.subscription.deleteMany({
			where: { subjectType: "FEATURE", subjectId: storyId },
		});

		return await tx.userStory.delete({
			where: { id: storyId, projectId },
		});
	});
}

/**
 * Bulk create stories from pipeline
 */
export async function bulkCreateStories(
	projectId: string,
	createdById: string,
	stories: {
		title: string;
		description?: string;
		acceptanceCriteria?: string;
		priority?: StoryPriority;
		size?: StorySize;
		storyPoints?: number;
		labels?: string[];
		source?: StorySource;
		tasks?: {
			title: string;
			description?: string;
			estimatedHours?: number;
		}[];
	}[],
	pipelineExecutionId?: string,
	defaultSource: StorySource = "MANUAL",
) {
	// Status resolution mirrors `createStory` — done up front so the
	// per-iteration `createStory` call doesn't re-do it for every row.
	// (`createStory` will independently resolve the default status when
	// `statusId` is omitted, but we still bootstrap here to surface a clear
	// error if the project has none and seeding fails.)
	let defaultStatus = await db.projectStoryStatus.findFirst({
		where: { projectId, isDefault: true },
	});

	if (!defaultStatus) {
		await createDefaultStoryStatuses(projectId);
		defaultStatus = await db.projectStoryStatus.findFirst({
			where: { projectId, isDefault: true },
		});
	}
	if (!defaultStatus?.id) {
		throw new Error("Default story status could not be resolved");
	}

	const statusId = defaultStatus.id;

	const createdStories = [];

	for (const storyData of stories) {
		// Route through `createStory` so identifier allocation goes through
		// the atomic per-project counter (`allocateNextStoryNumber`) and the
		// "View in Fabric" back-link is persisted by the single source of
		// truth. The previous F-NNN per-row counter is gone per spec
		// 2026-05-21 §A2.
		const story = await createStory({
			projectId,
			statusId,
			title: storyData.title,
			description: storyData.description,
			acceptanceCriteria: storyData.acceptanceCriteria,
			priority: storyData.priority ?? "P2_MEDIUM",
			size: storyData.size,
			storyPoints: storyData.storyPoints,
			labels: storyData.labels ?? [],
			createdById,
			pipelineExecutionId,
			source: storyData.source ?? defaultSource,
		});

		// Create tasks if provided
		if (storyData.tasks && storyData.tasks.length > 0) {
			let taskOrder = 0;
			let taskNum = 1;
			for (const taskData of storyData.tasks) {
				await db.storyTask.create({
					data: {
						storyId: story.id,
						identifier: `TASK-${String(taskNum).padStart(3, "0")}`,
						title: taskData.title,
						description: taskData.description,
						estimatedHours: taskData.estimatedHours,
						order: taskOrder,
					},
				});
				taskOrder++;
				taskNum++;
			}
		}

		// Fetch the story with tasks included
		const storyWithTasks = await db.userStory.findUnique({
			where: { id: story.id },
			include: {
				tasks: {
					orderBy: { order: "asc" },
				},
			},
		});

		if (!storyWithTasks) {
			throw new Error("Story not found after bulk creation");
		}

		createdStories.push(storyWithTasks);
	}

	return createdStories;
}

// ============================================================================
// Story Task Queries
// ============================================================================

/**
 * Generate next task identifier for a story (e.g., "TASK-001")
 */
export async function generateTaskIdentifier(storyId: string): Promise<string> {
	const lastTask = await db.storyTask.findFirst({
		where: { storyId },
		orderBy: { createdAt: "desc" },
		select: { identifier: true },
	});

	if (!lastTask) {
		return "TASK-001";
	}

	const match = lastTask.identifier.match(/TASK-(\d+)/);
	const nextNum = match ? Number.parseInt(match[1], 10) + 1 : 1;
	return `TASK-${String(nextNum).padStart(3, "0")}`;
}

/**
 * List tasks for a story
 */
export async function listTasks(storyId: string) {
	return await db.storyTask.findMany({
		where: { storyId },
		orderBy: { order: "asc" },
		include: {
			subtasks: {
				orderBy: { order: "asc" },
			},
		},
	});
}

/**
 * Create a task
 */
export async function createTask(data: {
	storyId: string;
	title: string;
	description?: string;
	estimatedHours?: number;
}) {
	const identifier = await generateTaskIdentifier(data.storyId);

	// Get next order
	const lastTask = await db.storyTask.findFirst({
		where: { storyId: data.storyId },
		orderBy: { order: "desc" },
		select: { order: true },
	});
	const order = (lastTask?.order ?? 0) + 1;

	return await db.storyTask.create({
		data: {
			storyId: data.storyId,
			identifier,
			title: data.title,
			description: data.description,
			estimatedHours: data.estimatedHours,
			order,
		},
		include: {
			subtasks: true,
		},
	});
}

/**
 * Update a task
 */
export async function updateTask(
	taskId: string,
	data: {
		title?: string;
		description?: string | null;
		isCompleted?: boolean;
		estimatedHours?: number | null;
		externalId?: string | null;
		// Repository context for code tasks
		repositoryUrl?: string | null;
		repositoryOwner?: string | null;
		repositoryName?: string | null;
		targetBranch?: string | null;
	},
) {
	return await db.storyTask.update({
		where: { id: taskId },
		data,
		include: {
			subtasks: true,
		},
	});
}

/**
 * Toggle task completion
 */
export async function toggleTaskComplete(taskId: string) {
	const task = await db.storyTask.findUnique({
		where: { id: taskId },
		select: { isCompleted: true },
	});

	if (!task) {
		throw new Error("Task not found");
	}

	return await db.storyTask.update({
		where: { id: taskId },
		data: { isCompleted: !task.isCompleted },
	});
}

/**
 * Delete a task
 */
export async function deleteTask(taskId: string) {
	return await db.storyTask.delete({
		where: { id: taskId },
	});
}

/**
 * Reorder tasks within a story
 */
export async function reorderTasks(
	_storyId: string,
	taskOrders: { id: string; order: number }[],
) {
	return await db.$transaction(
		taskOrders.map(({ id, order }) =>
			db.storyTask.update({
				where: { id },
				data: { order },
			}),
		),
	);
}

// ============================================================================
// Subtask Queries
// ============================================================================

/**
 * Create a subtask
 */
export async function createSubtask(data: { taskId: string; title: string }) {
	// Get next order
	const lastSubtask = await db.storySubtask.findFirst({
		where: { taskId: data.taskId },
		orderBy: { order: "desc" },
		select: { order: true },
	});
	const order = (lastSubtask?.order ?? 0) + 1;

	return await db.storySubtask.create({
		data: {
			taskId: data.taskId,
			title: data.title,
			order,
		},
	});
}

/**
 * Update a subtask
 */
export async function updateSubtask(
	subtaskId: string,
	data: {
		title?: string;
		isCompleted?: boolean;
	},
) {
	return await db.storySubtask.update({
		where: { id: subtaskId },
		data,
	});
}

/**
 * Toggle subtask completion
 */
export async function toggleSubtaskComplete(subtaskId: string) {
	const subtask = await db.storySubtask.findUnique({
		where: { id: subtaskId },
		select: { isCompleted: true },
	});

	if (!subtask) {
		throw new Error("Subtask not found");
	}

	return await db.storySubtask.update({
		where: { id: subtaskId },
		data: { isCompleted: !subtask.isCompleted },
	});
}

/**
 * Delete a subtask
 */
export async function deleteSubtask(subtaskId: string) {
	return await db.storySubtask.delete({
		where: { id: subtaskId },
	});
}

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Load a subset of a project's stories (and their tasks) for the bulk
 * download procedure. The caller is expected to have already authorized the
 * caller for the project at the procedure layer; this function only filters
 * by `projectId + id IN storyIds` so any IDs from another tenant are
 * silently dropped (defence-in-depth).
 *
 * Tasks are returned ordered by their `order` ascending so the rendered
 * Markdown is stable across calls.
 */
export async function getStoriesForDownload(
	projectId: string,
	storyIds: ReadonlyArray<string>,
) {
	if (storyIds.length === 0) {
		return [] as const;
	}
	return await db.userStory.findMany({
		where: {
			projectId,
			id: { in: [...storyIds] },
		},
		include: {
			tasks: {
				orderBy: { order: "asc" },
			},
		},
	});
}

/**
 * Clear all stories and their tasks for a project
 * Used before pushing new stories from a document.
 *
 * Captures the story IDs and their attachment storage keys, then deletes ONLY
 * the captured IDs — so a pipeline story committed concurrently (after capture)
 * is left for the next run instead of being cascade-deleted without its key
 * being captured (which would orphan its R2 object unrecoverably). Returns the
 * captured `attachmentKeys` so the caller can delete the underlying objects
 * (the FK cascade deletes rows, not files).
 *
 * @param clearPipelineOnly - If true, only delete stories generated by the
 *   pipeline (pipelineExecutionId IS NOT NULL), preserving manual Roadmap stories.
 */
export async function clearProjectStories(
	projectId: string,
	clearPipelineOnly?: boolean,
): Promise<{ count: number; attachmentKeys: string[] }> {
	const where: Prisma.UserStoryWhereInput = {
		projectId,
		...(clearPipelineOnly ? { pipelineExecutionId: { not: null } } : {}),
	};
	return await db.$transaction(async (tx) => {
		const stories = await tx.userStory.findMany({
			where,
			select: { id: true },
		});
		const ids = stories.map((s) => s.id);
		if (ids.length === 0) {
			return { count: 0, attachmentKeys: [] };
		}
		// Lock the captured story rows FOR UPDATE before reading their attachment
		// keys. create-attachment.ts reserves a StoryAttachment inside a txn that
		// locks the SAME user_story row (`SELECT id FROM user_story WHERE id = $1
		// FOR UPDATE`) and copies the final object only AFTER that txn commits.
		// The lock closes the worst window: an attachment row inserted between the
		// findMany and the deleteMany would otherwise be cascade-deleted with its
		// storageKey never captured → unrecoverable orphan. It also serializes a
		// concurrent reserve that has not yet committed (it blocks until these
		// stories are gone, then fails to reserve against the deleted row, so no
		// final object is ever written).
		// RESIDUAL (accepted — parity with the shipped single-story delete path):
		// an attachment that COMMITTED its row just before this lock but runs its
		// copyFile AFTER we capture+delete its key recreates the object post-delete
		// — a window the row lock cannot close, because the copy happens outside the
		// reserve txn. The durable fix is a post-copy existence re-check in
		// create-attachment (tracked follow-up); all deletion paths stay best-effort.
		await tx.$queryRaw`SELECT id FROM user_story WHERE id IN (${Prisma.join(
			ids,
		)}) FOR UPDATE`;
		const attachments = await tx.storyAttachment.findMany({
			where: { storyId: { in: ids } },
			select: { storageKey: true },
		});
		const result = await tx.userStory.deleteMany({
			where: { id: { in: ids } },
		});
		return {
			count: result.count,
			attachmentKeys: attachments.map((a) => a.storageKey),
		};
	});
}

import {
	getAccessibleFrameById,
	listWorkspaceReviewHistory,
	type Prisma,
	WorkspaceWorkflowBindingConflictError,
	type WorkspaceWorkflowBindingGuard,
} from "@repo/database";
import {
	adoStoryReviewConfigFieldsSchema,
	adoStoryReviewConfigSchema,
	workspaceStoryReviewRunBindingSchema,
} from "@repo/temporal/ado-story-review-config";
import { ADO_STORY_REVIEW_NODE_TYPE } from "@repo/temporal/workflow-node-types";
import {
	findScheduleCron,
	findScheduleTimezone,
} from "@repo/temporal/workflow-builder-schedule";
import { z } from "zod";
import { findAgenticPublishProblems } from "./agentic-publish-validation";
import {
	loadEditableWorkflow,
	loadReadableWorkflow,
	requireWritableProject,
	WorkflowCommandError,
	type WorkflowActor,
} from "./workflow-command-context";
import {
	applyWorkflowUpdateWithSchedule,
	type EditableWorkflow,
} from "./workflow-commands";
import { startWorkflowExecutionCommand } from "./workflow-execution-commands";
import { validateWorkflowBeforeExecution } from "./workflow-validation";

/** Supplied by the gateway after opening the current Workspace as the caller. */
export interface WorkspaceReviewBinding {
	id: string;
	userId: string;
	organizationId: string;
	projectId: string;
}

export const workspaceStoryReviewReadSchema = z
	.object({ workflowId: z.string().min(1).max(128) })
	.strict();

export const workspaceStoryReviewEditSchema = workspaceStoryReviewReadSchema
	.extend({
		expectedUpdatedAt: z.string().datetime({ offset: true }),
		config: adoStoryReviewConfigFieldsSchema
			.omit({ workspaceFrameId: true })
			.strict(),
		schedule: z
			.object({
				cron: z.string().trim().min(1).max(256),
				timezone: z.string().trim().min(1).max(128),
			})
			.strict(),
	})
	.strict();

export const workspaceStoryReviewRunSchema = workspaceStoryReviewReadSchema
	.extend({
		expectedUpdatedAt: z.string().datetime({ offset: true }),
		idempotencyKey: z.string().min(1).max(128),
		forceReview: z.boolean().default(false),
	})
	.strict();

export const workspaceStoryReviewHistorySchema = workspaceStoryReviewReadSchema
	.extend({
		limit: z.number().int().min(1).max(20).default(10),
		offset: z.number().int().min(0).max(1000).default(0),
	})
	.strict();

export interface WorkspaceReviewExecutionBinding
	extends WorkspaceReviewBinding {
	updatedAt: Date;
}

const runNodesSchema = z.array(
	z
		.object({
			id: z.string(),
			type: z.string(),
			data: z.record(z.string(), z.unknown()),
			position: z
				.object({ x: z.number(), y: z.number() })
				.default({ x: 0, y: 0 }),
		})
		.passthrough(),
);
const runEdgesSchema = z.array(
	z
		.object({
			id: z.string(),
			source: z.string(),
			target: z.string(),
			sourceHandle: z.string().optional(),
			targetHandle: z.string().optional(),
		})
		.passthrough(),
);
const count = z.number().int().min(0).max(50);
const reviewSelectionSchema = z.object({
	sprintContext: adoStoryReviewConfigFieldsSchema.shape.sprintContext,
	assignee: adoStoryReviewConfigFieldsSchema.shape.assignee,
	workItemTypes: z.array(z.string().trim().min(1).max(128)).min(1).max(20),
});
const reviewResultSchema = z.object({
	counts: z
		.object({
			total: count,
			reviewed: count,
			reused: count,
			removed: count,
		})
		.refine((value) => value.reviewed + value.reused === value.total),
	forced: z.boolean(),
	capture: z.object({ requirementsAsOf: z.string().datetime() }),
	selection: z.unknown().optional(),
});

function executionGuard(
	workflow: EditableWorkflow,
	binding: WorkspaceReviewExecutionBinding,
	expectedUpdatedAt = workflow.updatedAt,
): WorkspaceWorkflowBindingGuard {
	return {
		workflowId: workflow.id,
		userId: binding.userId,
		organizationId: binding.organizationId,
		projectId: binding.projectId,
		workspaceFrameId: binding.id,
		workflowUpdatedAt: expectedUpdatedAt,
		frameUpdatedAt: binding.updatedAt,
		status: workflow.status,
	};
}

function bindingConflict(error: unknown): never {
	if (error instanceof WorkspaceWorkflowBindingConflictError) {
		throw new WorkflowCommandError("CONFLICT", error.message);
	}
	throw error;
}

export async function runWorkspaceStoryReviewCommand(
	actor: WorkflowActor,
	binding: WorkspaceReviewExecutionBinding,
	input: z.input<typeof workspaceStoryReviewRunSchema>,
) {
	requireBindingActor(actor, binding);
	const parsed = workspaceStoryReviewRunSchema.safeParse(input);
	if (!parsed.success) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Pass the workflow, current timestamp, idempotency key and optional force flag only.",
		);
	}
	const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);
	const current = await loadReadableWorkflow(actor, parsed.data.workflowId);
	const graph = boundGraph(current, binding);
	await requireWritableProject(actor, binding.projectId);
	const snapshot = {
		nodes: runNodesSchema.safeParse(graph.nodes),
		edges: runEdgesSchema.safeParse(graph.edges),
	};
	if (!snapshot.nodes.success || !snapshot.edges.success) {
		badBinding();
	}
	try {
		const outcome = await startWorkflowExecutionCommand(actor, {
			workflowId: current.id,
			triggerData: { forceReview: parsed.data.forceReview },
			idempotencyKey: `workspace-review:${binding.id}:${parsed.data.idempotencyKey}`,
			requirePublished: true,
			confirmedProjectId: binding.projectId,
			source: "workspace-story-review",
			nodes: snapshot.nodes.data,
			edges: snapshot.edges.data,
			workspaceReview: {
				binding: executionGuard(current, binding, expectedUpdatedAt),
				nodeId: graph.reviewId,
			},
		});
		if (outcome.deduplicated) {
			const stored = outcome.execution.triggerInput;
			const marker = workspaceStoryReviewRunBindingSchema.safeParse(
				jsonObject(stored) ? stored.workspaceReviewBinding : undefined,
			);
			if (
				!jsonObject(stored) ||
				stored.source !== "workspace-story-review" ||
				!marker.success ||
				marker.data.workflowId !== current.id ||
				marker.data.workspaceFrameId !== binding.id ||
				marker.data.projectId !== binding.projectId ||
				marker.data.nodeId !== graph.reviewId ||
				marker.data.workflowUpdatedAt !==
					expectedUpdatedAt.toISOString() ||
				marker.data.frameUpdatedAt !==
					binding.updatedAt.toISOString() ||
				marker.data.forceReview !== parsed.data.forceReview
			) {
				throw new WorkflowCommandError(
					"CONFLICT",
					"This idempotency key belongs to a different review request. Read its run before starting another.",
				);
			}
		}
		return {
			workflowId: current.id,
			executionId: outcome.execution.id,
			startStatus: outcome.status,
			deduplicated: outcome.deduplicated ?? false,
			failure:
				outcome.status === "failed"
					? (outcome.failure ?? "execution-failed")
					: null,
		};
	} catch (error) {
		bindingConflict(error);
	}
}

export async function listWorkspaceStoryReviewRunsCommand(
	actor: WorkflowActor,
	binding: WorkspaceReviewExecutionBinding,
	input: z.input<typeof workspaceStoryReviewHistorySchema>,
) {
	requireBindingActor(actor, binding);
	const parsed = workspaceStoryReviewHistorySchema.safeParse(input);
	if (!parsed.success) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Pass only the workflow and bounded history pagination.",
		);
	}
	const current = await loadReadableWorkflow(actor, parsed.data.workflowId);
	const graph = boundGraph(current, binding);
	try {
		const result = await listWorkspaceReviewHistory({
			limit: parsed.data.limit,
			offset: parsed.data.offset,
			nodeId: graph.reviewId,
			binding: executionGuard(current, binding),
		});
		const nextOffset =
			result.hasMore &&
			result.nextOffset !== undefined &&
			result.nextOffset <= 1000
				? result.nextOffset
				: null;
		return {
			workflowId: current.id,
			hasMore: nextOffset !== null,
			nextOffset,
			runs: await Promise.all(
				result.executions.map(async (run) => {
					const result = reviewResultSchema.safeParse(run.review);
					const selection = reviewSelectionSchema.safeParse(
						result.success ? result.data.selection : undefined,
					);
					const candidate = run.frameId;
					const frame =
						candidate && candidate.length <= 128
							? await getAccessibleFrameById({
									id: candidate,
									userId: actor.userId,
									organizationId: actor.organizationId,
								})
							: null;
					return {
						id: run.id,
						status: run.status,
						triggerType: run.triggerType,
						startedAt: run.startedAt,
						completedAt: run.completedAt,
						durationMs: run.duration,
						hasError: run.hasError,
						frameId:
							frame?.organizationId === actor.organizationId &&
							frame.projectId === binding.projectId &&
							frame.surface === "artifact"
								? frame.id
								: null,
						review: result.success
							? {
									counts: result.data.counts,
									forced: result.data.forced,
									requirementsAsOf:
										result.data.capture.requirementsAsOf,
									selection: selection.success
										? selection.data
										: null,
								}
							: null,
					};
				}),
			),
		};
	} catch (error) {
		bindingConflict(error);
	}
}

function badBinding(): never {
	throw new WorkflowCommandError(
		"BAD_REQUEST",
		"This workflow is not a supported review workflow for this Workspace.",
	);
}

function jsonObject(
	value: Prisma.JsonValue | undefined,
): value is Prisma.JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundGraph(
	workflow: EditableWorkflow,
	binding: WorkspaceReviewBinding,
) {
	if (
		workflow.organizationId !== binding.organizationId ||
		workflow.userId !== binding.userId ||
		workflow.projectId !== binding.projectId ||
		!Array.isArray(workflow.nodes) ||
		!Array.isArray(workflow.edges)
	) {
		badBinding();
	}
	const nodes = workflow.nodes;
	for (const node of nodes) {
		if (
			!jsonObject(node) ||
			typeof node.id !== "string" ||
			typeof node.type !== "string" ||
			!jsonObject(node.data)
		) {
			badBinding();
		}
	}
	const reviews = nodes.filter(
		(node) => jsonObject(node) && node.type === ADO_STORY_REVIEW_NODE_TYPE,
	);
	const triggers = nodes.filter(
		(node) => jsonObject(node) && node.type === "trigger",
	);
	if (reviews.length !== 1 || triggers.length !== 1) {
		badBinding();
	}
	const review = reviews[0];
	const trigger = triggers[0];
	if (
		!jsonObject(review) ||
		typeof review.id !== "string" ||
		!jsonObject(review.data) ||
		!jsonObject(trigger) ||
		typeof trigger.id !== "string" ||
		!jsonObject(trigger.data) ||
		!jsonObject(trigger.data.config)
	) {
		badBinding();
	}
	const parsed = adoStoryReviewConfigSchema.safeParse(review.data.config);
	if (
		!parsed.success ||
		parsed.data.workspaceFrameId !== binding.id ||
		String(trigger.data.config.triggerType).toLowerCase() !== "schedule"
	) {
		badBinding();
	}
	if (
		new Set(nodes.map((node) => (jsonObject(node) ? node.id : null)))
			.size !== nodes.length
	) {
		badBinding();
	}
	return {
		nodes,
		edges: workflow.edges,
		reviewId: review.id,
		triggerId: trigger.id,
		config: parsed.data,
	};
}

function descriptor(
	workflow: EditableWorkflow,
	binding: WorkspaceReviewBinding,
) {
	const graph = boundGraph(workflow, binding);
	return {
		id: workflow.id,
		name: workflow.name,
		status: workflow.status,
		version: workflow.version,
		updatedAt: workflow.updatedAt.toISOString(),
		nodeId: graph.reviewId,
		config: graph.config,
		schedule: {
			cron: findScheduleCron(graph.nodes),
			timezone: findScheduleTimezone(graph.nodes) ?? "UTC",
		},
		source: {
			workflowId: workflow.id,
			workspaceFrameId: binding.id,
			projectId: binding.projectId,
		},
	};
}

function requireBindingActor(
	actor: WorkflowActor,
	binding: WorkspaceReviewBinding,
) {
	if (
		binding.organizationId !== actor.organizationId ||
		binding.userId !== actor.userId
	) {
		throw new WorkflowCommandError(
			"FORBIDDEN",
			"Only the Workspace owner can configure or read its review workflow.",
		);
	}
}

export async function getWorkspaceStoryReviewCommand(
	actor: WorkflowActor,
	binding: WorkspaceReviewBinding,
	workflowId: string,
) {
	requireBindingActor(actor, binding);
	return descriptor(await loadReadableWorkflow(actor, workflowId), binding);
}

export async function configureWorkspaceStoryReviewCommand(
	actor: WorkflowActor,
	binding: WorkspaceReviewBinding,
	input: z.input<typeof workspaceStoryReviewEditSchema>,
) {
	requireBindingActor(actor, binding);
	const parsed = workspaceStoryReviewEditSchema.safeParse(input);
	if (!parsed.success) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Pass valid review settings, schedule and expectedUpdatedAt only.",
		);
	}
	const current = await loadEditableWorkflow(
		actor,
		parsed.data.workflowId,
		"edit",
	);
	const graph = boundGraph(current, binding);
	await requireWritableProject(actor, binding.projectId);
	const config = adoStoryReviewConfigSchema.parse({
		...parsed.data.config,
		workspaceFrameId: binding.id,
	});
	const nodes = graph.nodes.map((node) => {
		if (!jsonObject(node) || !jsonObject(node.data)) {
			badBinding();
		}
		if (node.id === graph.reviewId) {
			return { ...node, data: { ...node.data, config } };
		}
		if (node.id === graph.triggerId && jsonObject(node.data.config)) {
			return {
				...node,
				data: {
					...node.data,
					config: {
						...node.data.config,
						scheduleCron: parsed.data.schedule.cron,
						scheduleTimezone: parsed.data.schedule.timezone,
					},
				},
			};
		}
		return node;
	});
	const validation = validateWorkflowBeforeExecution(nodes, graph.edges);
	if (!validation.valid) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			validation.errors.join("\n"),
		);
	}
	const { problems } = await findAgenticPublishProblems({
		nodes,
		userId: actor.userId,
		organizationId: actor.organizationId,
		projectId: binding.projectId,
	});
	if (problems.length) {
		throw new WorkflowCommandError("BAD_REQUEST", problems.join("\n"));
	}
	try {
		const { workflow, schedule } = await applyWorkflowUpdateWithSchedule(
			actor,
			current,
			{ id: current.id, nodes },
			{ expectedUpdatedAt: new Date(parsed.data.expectedUpdatedAt) },
		);
		return {
			workflow: descriptor({ ...current, ...workflow }, binding),
			schedule,
		};
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			error.code === "P2025"
		) {
			throw new WorkflowCommandError(
				"CONFLICT",
				"The workflow changed. Read its current settings before saving again.",
			);
		}
		throw error;
	}
}

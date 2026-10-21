import { createHash } from "node:crypto";
import {
	canRunOrganizationWorkflows,
	canUpdateOrganizationFrames,
	getAccessibleFrameById,
	getWorkspacePublishedWorkflowGraph,
	getWorkspaceWorkflowGrant,
	listWorkspaceWorkflowHistory,
	mutateWorkspaceWorkflowBinding,
	WorkspaceWorkflowBindingConflictError,
	type WorkspaceWorkflowReadGuard,
	type WorkspaceWorkflowRowGuard,
	type WorkspaceWorkflowRunGuard,
} from "@repo/database";
import {
	findScheduleCron,
	findScheduleTimezone,
} from "@repo/temporal/workflow-builder-schedule";
import { z } from "zod";
import {
	loadEditableWorkflow,
	loadReadableWorkflow,
	requireWorkflowPermission,
	requireWritableProject,
	WorkflowCommandError,
	type WorkflowActor,
} from "./workflow-command-context";
import { startWorkflowExecutionCommand } from "./workflow-execution-commands";

const id = z.string().min(1).max(128);
const timestamp = z.string().datetime({ offset: true });
export const workspaceWorkflowReadSchema = z
	.object({ frameId: id, workflowId: id })
	.strict();
const workspaceWorkflowBindSchema = workspaceWorkflowReadSchema
	.extend({
		action: z.enum(["bind", "unbind"]),
		expectedFrameUpdatedAt: timestamp,
		expectedWorkflowUpdatedAt: timestamp,
	})
	.strict();
const workspaceWorkflowRunSchema = workspaceWorkflowReadSchema
	.extend({
		expectedFrameUpdatedAt: timestamp,
		expectedWorkflowUpdatedAt: timestamp,
		idempotencyKey: id,
		inputs: z
			.record(z.string(), z.json())
			.refine(
				(value) =>
					Buffer.byteLength(JSON.stringify(value), "utf8") <= 16_384,
			)
			.default({}),
	})
	.strict();
const workspaceWorkflowHistorySchema = workspaceWorkflowReadSchema
	.extend({
		limit: z.number().int().min(1).max(20).default(10),
		offset: z.number().int().min(0).max(1000).default(0),
	})
	.strict();

const graphSchema = z.object({
	nodes: z.array(
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
	),
	edges: z.array(
		z
			.object({
				id: z.string(),
				source: z.string(),
				target: z.string(),
				sourceHandle: z.string().optional(),
				targetHandle: z.string().optional(),
			})
			.passthrough(),
	),
	variables: z.record(z.string(), z.json()).nullable(),
});

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
	const parsed = schema.safeParse(input);
	if (!parsed.success) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Pass only the documented Workspace workflow arguments within their limits.",
		);
	}
	return parsed.data;
}

async function bindingErrors<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof WorkspaceWorkflowBindingConflictError) {
			throw new WorkflowCommandError("CONFLICT", error.message);
		}
		throw error;
	}
}

function requireSameProject(
	actor: WorkflowActor,
	frame: {
		userId: string;
		organizationId?: string | null;
		projectId?: string | null;
		surface?: string;
	},
	workflow: {
		userId: string;
		organizationId: string | null;
		projectId: string | null;
		status: string;
		version: number;
		publishedVersion: number | null;
	},
	requirePublished = true,
) {
	if (
		frame.surface !== "workspace" ||
		frame.userId !== actor.userId ||
		workflow.userId !== actor.userId ||
		frame.organizationId !== actor.organizationId ||
		workflow.organizationId !== actor.organizationId ||
		!frame.projectId ||
		frame.projectId !== workflow.projectId ||
		(actor.projectRestrictionId !== undefined &&
			frame.projectId !== actor.projectRestrictionId)
	) {
		throw new WorkflowCommandError(
			"NOT_FOUND",
			"Workspace workflow not found.",
		);
	}
	if (
		requirePublished &&
		((workflow.status !== "PUBLISHED" && workflow.status !== "ACTIVE") ||
			workflow.publishedVersion !== workflow.version)
	) {
		throw new WorkflowCommandError(
			"CONFLICT",
			"Publish the workflow before binding or running it from a Workspace.",
		);
	}
}

export async function bindWorkspaceWorkflowCommand(
	actor: WorkflowActor,
	input: unknown,
	auditActor: {
		userId: string;
		emailSnapshot?: string;
		nameSnapshot?: string;
	},
) {
	const parsed = parse(workspaceWorkflowBindSchema, input);
	await requireWorkflowPermission(
		canUpdateOrganizationFrames,
		actor,
		"You do not have permission to change Workspaces.",
	);
	await requireWorkflowPermission(
		canRunOrganizationWorkflows,
		actor,
		"You do not have permission to run workflows.",
	);
	const workflow = await loadEditableWorkflow(
		actor,
		parsed.workflowId,
		"edit",
	);
	const frame = await getAccessibleFrameById({
		id: parsed.frameId,
		userId: actor.userId,
		organizationId: actor.organizationId,
	});
	if (!frame) {
		throw new WorkflowCommandError(
			"NOT_FOUND",
			"Workspace workflow not found.",
		);
	}
	requireSameProject(actor, frame, workflow, parsed.action === "bind");
	const projectId = frame.projectId;
	if (!projectId) {
		throw new WorkflowCommandError("NOT_FOUND", "Project not found.");
	}
	await requireWritableProject(actor, projectId);
	const binding: WorkspaceWorkflowRowGuard = {
		workflowId: workflow.id,
		userId: actor.userId,
		organizationId: actor.organizationId,
		projectId,
		workspaceFrameId: frame.id,
		frameUpdatedAt: new Date(parsed.expectedFrameUpdatedAt),
		workflowUpdatedAt: new Date(parsed.expectedWorkflowUpdatedAt),
		status: workflow.status,
		requirement: { kind: "row-only" },
	};
	if (parsed.action === "bind") {
		const graph = await bindingErrors(() =>
			getWorkspacePublishedWorkflowGraph(binding),
		);
		requirePublishedGraphMatches(workflow, graph);
	}
	const mutation =
		parsed.action === "bind"
			? { action: parsed.action, workflowVersion: workflow.version }
			: { action: parsed.action };
	return bindingErrors(() =>
		mutateWorkspaceWorkflowBinding({
			binding,
			...mutation,
			auditActor,
		}),
	);
}

async function loadBoundWorkflow(
	actor: WorkflowActor,
	input: z.output<typeof workspaceWorkflowReadSchema>,
) {
	const workflow = await loadReadableWorkflow(actor, input.workflowId);
	const context = await getWorkspaceWorkflowGrant({
		...input,
		userId: actor.userId,
		organizationId: actor.organizationId,
	});
	if (!context) {
		throw new WorkflowCommandError(
			"NOT_FOUND",
			"Workspace workflow not found. Ask the Agent to bind its published version first.",
		);
	}
	const { frame, grant } = context;
	requireSameProject(
		actor,
		{ ...frame, surface: "workspace" },
		workflow,
		false,
	);
	const projectId = frame.projectId;
	if (!projectId) {
		throw new WorkflowCommandError("NOT_FOUND", "Project not found.");
	}
	await requireWritableProject(actor, projectId);
	const grantIsStale =
		workflow.version !== grant.authorizedWorkflowVersion ||
		workflow.updatedAt.toISOString() !== grant.authorizedWorkflowUpdatedAt;
	const guard: WorkspaceWorkflowReadGuard = {
		workflowId: workflow.id,
		userId: actor.userId,
		organizationId: actor.organizationId,
		projectId,
		workspaceFrameId: frame.id,
		workflowUpdatedAt: workflow.updatedAt,
		frameUpdatedAt: frame.updatedAt,
		status: workflow.status,
		requirement: { kind: "bound-read" },
	};
	const graph = await bindingErrors(() =>
		getWorkspacePublishedWorkflowGraph(guard),
	);
	const executable =
		!grantIsStale &&
		(workflow.status === "PUBLISHED" || workflow.status === "ACTIVE") &&
		workflow.version === workflow.publishedVersion &&
		publishedGraphMatches(workflow, graph);
	return { workflow, frame, grant, guard, graph, executable };
}

export async function getWorkspaceWorkflowCommand(
	actor: WorkflowActor,
	input: unknown,
) {
	const parsed = parse(workspaceWorkflowReadSchema, input);
	const { workflow, frame, guard, executable } = await loadBoundWorkflow(
		actor,
		parsed,
	);
	return {
		workflowId: workflow.id,
		name: workflow.name.slice(0, 255),
		status: workflow.status,
		version: workflow.version,
		executable,
		needsConfirmation: !executable,
		workflowUpdatedAt: workflow.updatedAt.toISOString(),
		frameUpdatedAt: frame.updatedAt.toISOString(),
		schedule: {
			cron: findScheduleCron(workflow.nodes)?.slice(0, 256) ?? null,
			timezone:
				findScheduleTimezone(workflow.nodes)?.slice(0, 128) ?? "UTC",
		},
		source: {
			workflowId: workflow.id,
			workspaceFrameId: frame.id,
			projectId: guard.projectId,
		},
	};
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(
				([key, item]) =>
					`${JSON.stringify(key)}:${canonicalJson(item)}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

type PersistedGraph = { nodes: unknown; edges: unknown; variables: unknown };

function requirePublishedGraphMatches(
	workflow: PersistedGraph,
	graph: PersistedGraph | null,
): asserts graph is PersistedGraph {
	if (!publishedGraphMatches(workflow, graph)) {
		throw new WorkflowCommandError(
			"CONFLICT",
			"Publish the current changes before binding or running this workflow.",
		);
	}
}

function publishedGraphMatches(
	workflow: PersistedGraph,
	graph: PersistedGraph | null,
): boolean {
	return (
		graph !== null &&
		canonicalJson({
			nodes: workflow.nodes,
			edges: workflow.edges,
			variables: workflow.variables,
		}) === canonicalJson(graph)
	);
}

export async function runWorkspaceWorkflowCommand(
	actor: WorkflowActor,
	input: unknown,
) {
	const parsed = parse(workspaceWorkflowRunSchema, input);
	const {
		workflow,
		frame,
		guard,
		grant,
		executable,
		graph: publishedGraph,
	} = await loadBoundWorkflow(actor, parsed);
	if (!executable) {
		requirePublishedGraphMatches(workflow, publishedGraph);
		throw new WorkflowCommandError(
			"CONFLICT",
			"The bound workflow changed. Ask the Agent to confirm its current version again.",
		);
	}
	if (
		frame.updatedAt.getTime() !==
			new Date(parsed.expectedFrameUpdatedAt).getTime() ||
		workflow.updatedAt.getTime() !==
			new Date(parsed.expectedWorkflowUpdatedAt).getTime()
	) {
		throw new WorkflowCommandError(
			"CONFLICT",
			"The Workspace or workflow changed. Read its current settings again.",
		);
	}
	const graph = graphSchema.safeParse(publishedGraph);
	if (!graph.success) {
		throw new WorkflowCommandError(
			"CONFLICT",
			"The published workflow graph is unavailable.",
		);
	}
	const runGuard: WorkspaceWorkflowRunGuard = {
		...guard,
		requirement: {
			kind: "bound-run",
			workflowVersion: grant.authorizedWorkflowVersion,
		},
	};
	const outcome = await bindingErrors(() =>
		startWorkflowExecutionCommand(actor, {
			workflowId: workflow.id,
			requirePublished: true,
			confirmedProjectId: guard.projectId,
			idempotencyKey: `workspace-workflow:${frame.id}:${parsed.idempotencyKey}`,
			triggerData: parsed.inputs,
			nodes: graph.data.nodes,
			edges: graph.data.edges,
			variables: graph.data.variables ?? undefined,
			workspaceLaunch: {
				kind: "workflow",
				binding: runGuard,
				inputsFingerprint: createHash("sha256")
					.update(canonicalJson(parsed.inputs))
					.digest("hex"),
			},
		}),
	);
	return {
		workflowId: workflow.id,
		executionId: outcome.execution.id,
		startStatus: outcome.status,
		deduplicated: outcome.deduplicated ?? false,
		hasError: outcome.status === "failed",
	};
}

export async function listWorkspaceWorkflowRunsCommand(
	actor: WorkflowActor,
	input: unknown,
) {
	const parsed = parse(workspaceWorkflowHistorySchema, input);
	const { workflow, guard, executable } = await loadBoundWorkflow(
		actor,
		parsed,
	);
	return {
		workflowId: workflow.id,
		status: workflow.status,
		executable,
		needsConfirmation: !executable,
		...(await bindingErrors(() =>
			listWorkspaceWorkflowHistory({
				binding: guard,
				limit: parsed.limit,
				offset: parsed.offset,
			}),
		)),
	};
}

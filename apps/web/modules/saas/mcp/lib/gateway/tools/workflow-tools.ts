/**
 * Fabric MCP Gateway — workflow tools.
 *
 * List, read, create, edit, publish, pause, resume and run workflows, and read
 * a workflow's run history. Every tool is the same command the oRPC procedures
 * call (`@repo/api/modules/workflows/lib/*-commands`), so a workflow made from
 * chat, from Claude Code and from the builder is one thing with one set of
 * rules; this file only maps tool arguments onto those commands and their
 * outcomes onto results.
 *
 * Tools marked `_meta["fabric/confirm"]` change what runs on a schedule or
 * start a run, so Fabric's own chat asks the person first. Create and edit
 * accept `dryRun`, which returns the draft the person is asked to confirm and
 * writes nothing.
 */

import type { WorkflowActor } from "@repo/api/modules/workflows/lib/workflow-command-context";
import {
	PresetCreateArgsSchema,
	PresetUpdateArgsSchema,
} from "@repo/temporal/agentic-workflow-preset";
import { findPublishedFrameId } from "@repo/temporal/workflow-run-output";
import { z } from "zod";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession, ToolCallResult } from "../types";
import { clampLimit } from "./frame-context";
import {
	WORKFLOW_GRAPH_LIMITS,
	WORKFLOW_LIST_LIMIT,
	WORKFLOW_RUNS_LIMIT,
	WORKFLOW_STATUSES,
} from "./workflow-tool-definitions";

// ─── Arguments ──────────────────────────────────────────────────────────────

const WorkflowIdArgs = z.object({ workflowId: z.string().trim().min(1) });

/**
 * A `limit` brought into its bounds rather than refused, the way the frame and
 * page tools treat theirs: a page's script is written by a model, and a refusal
 * for asking for too many breaks the page.
 */
const boundedLimit = (bounds: { max: number; default: number }) =>
	z
		.number()
		.transform((value) =>
			clampLimit(value, { fallback: bounds.default, max: bounds.max }),
		);

const ListArgs = z.object({
	status: z.enum(WORKFLOW_STATUSES).optional(),
	scheduled: z.boolean().optional(),
	search: z.string().optional(),
	limit: boundedLimit(WORKFLOW_LIST_LIMIT).default(
		WORKFLOW_LIST_LIMIT.default,
	),
	offset: z.number().int().min(0).default(0),
});

const RunsArgs = WorkflowIdArgs.extend({
	limit: boundedLimit(WORKFLOW_RUNS_LIMIT).optional(),
});

const ExecutionArgs = z.object({ executionId: z.string().trim().min(1) });

const ExecuteArgs = WorkflowIdArgs.extend({
	inputs: z.record(z.string(), z.unknown()).optional(),
});

const GraphNodes = z
	.array(z.record(z.string(), z.unknown()))
	.max(WORKFLOW_GRAPH_LIMITS.nodes);
const GraphEdges = z
	.array(z.record(z.string(), z.unknown()))
	.max(WORKFLOW_GRAPH_LIMITS.edges);

const CreateArgs = z
	.object({
		preset: PresetCreateArgsSchema.optional(),
		name: z.string().trim().min(1).max(255).optional(),
		description: z.string().max(2_000).optional(),
		nodes: GraphNodes.optional(),
		edges: GraphEdges.optional(),
		projectId: z.string().min(1).optional(),
		dryRun: z.boolean().optional(),
	})
	.refine(
		(args) =>
			args.preset
				? args.nodes === undefined && args.edges === undefined
				: args.name !== undefined &&
					args.nodes !== undefined &&
					args.nodes.length > 0,
		{
			message:
				"Send either `preset`, or `name` with `nodes` and `edges` — not both",
		},
	);

const UpdateArgs = WorkflowIdArgs.extend({
	name: z.string().trim().min(1).max(255).optional(),
	description: z.string().max(2_000).optional(),
	preset: PresetUpdateArgsSchema.optional(),
	nodes: GraphNodes.optional(),
	edges: GraphEdges.optional(),
	dryRun: z.boolean().optional(),
}).refine((args) => !(args.preset && (args.nodes || args.edges)), {
	message: "Send either `preset` or `nodes` and `edges` — not both",
});

function parseArgs<Schema extends z.ZodType>(
	schema: Schema,
	args: Record<string, unknown>,
): { ok: true; data: z.infer<Schema> } | { ok: false; result: ToolCallResult } {
	const parsed = schema.safeParse(args);
	if (parsed.success) {
		return { ok: true, data: parsed.data };
	}
	return {
		ok: false,
		result: errorResult(
			parsed.error.issues
				.map((issue) =>
					issue.path.length > 0
						? `${issue.path.join(".")}: ${issue.message}`
						: issue.message,
				)
				.join("; "),
		),
	};
}

// ─── Shared pieces ──────────────────────────────────────────────────────────

/**
 * Loads a module on first use and keeps it. The workflow commands are imported
 * when a tool needs them rather than at module scope on purpose: they reach the
 * database and the workflow engine, and the gateway's other tools (and the
 * tests that exercise them) must not pay for, or fail without, that when no
 * workflow tool is used. A failed load is not remembered, so the next call
 * retries.
 */
function lazy<Module>(load: () => Promise<Module>): () => Promise<Module> {
	let loaded: Promise<Module> | undefined;
	return () => {
		loaded ??= load().catch((error: unknown) => {
			loaded = undefined;
			throw error;
		});
		return loaded;
	};
}

const contextModule = lazy(
	() => import("@repo/api/modules/workflows/lib/workflow-command-context"),
);
const lifecycleModule = lazy(
	() => import("@repo/api/modules/workflows/lib/workflow-commands"),
);
const draftModule = lazy(
	() => import("@repo/api/modules/workflows/lib/workflow-draft-commands"),
);
const executionModule = lazy(
	() => import("@repo/api/modules/workflows/lib/workflow-execution-commands"),
);
const readModule = lazy(
	() => import("@repo/api/modules/workflows/lib/workflow-read-commands"),
);
const scheduleModule = lazy(
	() =>
		import("@repo/api/modules/workflows/lib/workflow-schedule-description"),
);

const REQUIRES_ORGANIZATION =
	"Workflows belong to an organization. Switch to an organization and try again.";

/**
 * Runs `run` for the session's user in its organization, turning a command's
 * refusal into an error result written for a person.
 */
async function asActor(
	session: GatewaySession,
	run: (actor: WorkflowActor) => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
	if (!session.organizationId) {
		return errorResult(REQUIRES_ORGANIZATION);
	}
	const { WorkflowCommandError } = await contextModule();
	try {
		return await run({
			userId: session.userId,
			organizationId: session.organizationId,
			...(session.pageProjectId !== undefined
				? { projectRestrictionId: session.pageProjectId }
				: {}),
		});
	} catch (error) {
		if (error instanceof WorkflowCommandError) {
			return errorResult(error.message);
		}
		throw error;
	}
}

function summarizeWorkflow(workflow: {
	id: string;
	name: string;
	status: string;
	triggerType: string;
	projectId: string | null;
}) {
	return {
		id: workflow.id,
		name: workflow.name,
		status: workflow.status,
		triggerType: workflow.triggerType,
		projectId: workflow.projectId,
	};
}

// ─── Handlers ───────────────────────────────────────────────────────────────

type WorkflowToolHandler = (
	args: Record<string, unknown>,
	session: GatewaySession,
) => Promise<ToolCallResult>;

const handleListWorkflows: WorkflowToolHandler = async (args, session) => {
	const parsed = parseArgs(ListArgs, args);
	if (!parsed.ok) {
		return parsed.result;
	}
	const { scheduled, ...filters } = parsed.data;
	return asActor(session, async (actor) => {
		const [{ listWorkflowsCommand }, { describeWorkflowSchedule }] =
			await Promise.all([readModule(), scheduleModule()]);
		const result = await listWorkflowsCommand(actor, {
			...filters,
			...(scheduled ? { triggerType: "SCHEDULE" as const } : {}),
		});
		return jsonResult({
			workflows: result.workflows.map((workflow) => ({
				id: workflow.id,
				name: workflow.name,
				description: workflow.description,
				status: workflow.status,
				triggerType: workflow.triggerType,
				isPublished: !!workflow.publishedAt,
				projectId: workflow.projectId,
				schedule: describeWorkflowSchedule(workflow.nodes),
				createdAt: workflow.createdAt,
				updatedAt: workflow.updatedAt,
			})),
			total: result.total,
			hasMore: result.hasMore,
		});
	});
};

const handleGetWorkflow: WorkflowToolHandler = async (args, session) => {
	const parsed = parseArgs(WorkflowIdArgs, args);
	if (!parsed.ok) {
		return parsed.result;
	}
	return asActor(session, async (actor) => {
		const [
			{ getWorkflowWithLatestRunCommand },
			{ describeWorkflowSchedule },
		] = await Promise.all([readModule(), scheduleModule()]);
		const { workflow, latestRun } = await getWorkflowWithLatestRunCommand(
			actor,
			parsed.data.workflowId,
		);
		return jsonResult({
			id: workflow.id,
			name: workflow.name,
			description: workflow.description,
			status: workflow.status,
			triggerType: workflow.triggerType,
			isPublished: !!workflow.publishedAt,
			projectId: workflow.projectId,
			schedule: describeWorkflowSchedule(workflow.nodes),
			nodes: workflow.nodes,
			edges: workflow.edges,
			latestRun: latestRun
				? {
						id: latestRun.id,
						status: latestRun.status,
						startedAt: latestRun.startedAt,
						completedAt: latestRun.completedAt,
						error: latestRun.error,
						frameId: latestRun.frameId,
					}
				: null,
			createdAt: workflow.createdAt,
			updatedAt: workflow.updatedAt,
		});
	});
};

const handleListWorkflowRuns: WorkflowToolHandler = async (args, session) => {
	const parsed = parseArgs(RunsArgs, args);
	if (!parsed.ok) {
		return parsed.result;
	}
	return asActor(session, async (actor) => {
		const { listWorkflowRunsCommand } = await executionModule();
		const runs = await listWorkflowRunsCommand(actor, parsed.data);
		return jsonResult({ workflowId: parsed.data.workflowId, runs });
	});
};

const handleGetWorkflowExecution: WorkflowToolHandler = async (
	args,
	session,
) => {
	const parsed = parseArgs(ExecutionArgs, args);
	if (!parsed.ok) {
		return parsed.result;
	}
	return asActor(session, async (actor) => {
		const { getWorkflowExecutionCommand } = await readModule();
		const execution = await getWorkflowExecutionCommand(
			actor,
			parsed.data.executionId,
		);
		return jsonResult({
			id: execution.id,
			workflowId: execution.workflowId,
			status: execution.status,
			startedAt: execution.startedAt,
			completedAt: execution.completedAt,
			output: execution.output,
			frameId: findPublishedFrameId(execution.output),
			error: execution.error,
			duration: execution.duration,
		});
	});
};

const handleExecuteWorkflow: WorkflowToolHandler = async (args, session) => {
	const parsed = parseArgs(ExecuteArgs, args);
	if (!parsed.ok) {
		return parsed.result;
	}
	return asActor(session, async (actor) => {
		const { startWorkflowExecutionCommand } = await executionModule();
		const outcome = await startWorkflowExecutionCommand(actor, {
			workflowId: parsed.data.workflowId,
			triggerData: parsed.data.inputs ?? {},
			requirePublished: true,
			source: "mcp-gateway",
		});
		if (outcome.status === "failed") {
			return errorResult(`Failed to start workflow: ${outcome.message}`);
		}
		if (outcome.status === "unconfirmed") {
			// A normal result, not an error: agents retry errors, and a retry
			// is exactly the duplicate run this avoids.
			return jsonResult({
				executionId: outcome.execution.id,
				workflowId: parsed.data.workflowId,
				workflowName: outcome.workflowName,
				status: "unconfirmed",
				temporalWorkflowId: outcome.temporalWorkflowId,
				message: `${outcome.message} Do not call this tool again for this run; poll fabric_get_workflow_execution(executionId="${outcome.execution.id}").`,
			});
		}
		return jsonResult({
			executionId: outcome.execution.id,
			workflowId: parsed.data.workflowId,
			status: "RUNNING",
			message: `Workflow "${outcome.workflowName}" execution started. Use fabric_get_workflow_execution to check status.`,
		});
	});
};

const handleCreateWorkflow: WorkflowToolHandler = async (args, session) => {
	const parsed = parseArgs(CreateArgs, args);
	if (!parsed.ok) {
		return parsed.result;
	}
	const input = parsed.data;
	return asActor(session, async (actor) => {
		const {
			createWorkflowFromGraphCommand,
			createWorkflowFromPresetCommand,
		} = await draftModule();
		const outcome = input.preset
			? await createWorkflowFromPresetCommand(actor, {
					preset: input.preset,
					projectId: input.projectId,
					defaultProjectId: session.actingContext?.projectId,
					dryRun: input.dryRun,
				})
			: await createWorkflowFromGraphCommand(actor, {
					name: input.name ?? "",
					description: input.description,
					nodes: input.nodes ?? [],
					edges: input.edges ?? [],
					projectId: input.projectId,
					dryRun: input.dryRun,
				});
		if (!outcome.written) {
			return jsonResult({ draft: outcome.draft });
		}
		const { problems } = outcome.draft;
		return jsonResult({
			created: true,
			workflow: summarizeWorkflow(outcome.workflow),
			problems,
			next:
				problems.length > 0
					? "Fix the problems with fabric_update_workflow before publishing."
					: "Publish it with fabric_publish_workflow to put it on its schedule.",
		});
	});
};

const handleUpdateWorkflow: WorkflowToolHandler = async (args, session) => {
	const parsed = parseArgs(UpdateArgs, args);
	if (!parsed.ok) {
		return parsed.result;
	}
	return asActor(session, async (actor) => {
		const { updateWorkflowWithDraftCommand } = await draftModule();
		const outcome = await updateWorkflowWithDraftCommand(
			actor,
			parsed.data,
		);
		if (!outcome.written) {
			return jsonResult({ draft: outcome.draft });
		}
		return jsonResult({
			updated: true,
			workflow: summarizeWorkflow(outcome.workflow),
			problems: outcome.draft.problems,
			next: outcome.live
				? "The change applies from the next run. Call fabric_publish_workflow to record it as a new version."
				: "Publish it with fabric_publish_workflow to put it on its schedule.",
		});
	});
};

const handlePublishWorkflow: WorkflowToolHandler = async (args, session) => {
	const parsed = parseArgs(WorkflowIdArgs, args);
	if (!parsed.ok) {
		return parsed.result;
	}
	return asActor(session, async (actor) => {
		const { publishWorkflowCommand } = await lifecycleModule();
		const outcome = await publishWorkflowCommand(actor, {
			workflowId: parsed.data.workflowId,
		});
		if (!outcome.success) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							error: "The workflow cannot be published yet",
							problems: outcome.validation.errors,
						}),
					},
				],
				isError: true,
			};
		}
		return jsonResult({
			published: true,
			workflowId: parsed.data.workflowId,
			status: "PUBLISHED",
			version: outcome.version,
			schedule: outcome.schedule,
			warnings: outcome.validation.warnings,
		});
	});
};

const handleUnpublishWorkflow: WorkflowToolHandler = async (args, session) => {
	const parsed = parseArgs(WorkflowIdArgs, args);
	if (!parsed.ok) {
		return parsed.result;
	}
	return asActor(session, async (actor) => {
		const { unpublishWorkflowCommand } = await lifecycleModule();
		const outcome = await unpublishWorkflowCommand(
			actor,
			parsed.data.workflowId,
		);
		return jsonResult({
			workflowId: parsed.data.workflowId,
			status: "DRAFT",
			message: outcome.message,
		});
	});
};

const handlePauseWorkflow: WorkflowToolHandler = async (args, session) => {
	const parsed = parseArgs(WorkflowIdArgs, args);
	if (!parsed.ok) {
		return parsed.result;
	}
	return asActor(session, async (actor) => {
		const { pauseWorkflowCommand } = await lifecycleModule();
		const workflow = await pauseWorkflowCommand(
			actor,
			parsed.data.workflowId,
		);
		return jsonResult({
			workflowId: workflow.id,
			status: workflow.status,
			message: "Paused. Its schedule has stopped.",
		});
	});
};

const handleResumeWorkflow: WorkflowToolHandler = async (args, session) => {
	const parsed = parseArgs(WorkflowIdArgs, args);
	if (!parsed.ok) {
		return parsed.result;
	}
	return asActor(session, async (actor) => {
		const { resumeWorkflowCommand } = await lifecycleModule();
		const workflow = await resumeWorkflowCommand(
			actor,
			parsed.data.workflowId,
		);
		return jsonResult({
			workflowId: workflow.id,
			status: workflow.status,
			message: "Resumed. It runs on its schedule again.",
		});
	});
};

export const WORKFLOW_TOOL_HANDLERS: ReadonlyMap<string, WorkflowToolHandler> =
	new Map([
		["fabric_list_workflows", handleListWorkflows],
		["fabric_get_workflow", handleGetWorkflow],
		["fabric_list_workflow_runs", handleListWorkflowRuns],
		["fabric_get_workflow_execution", handleGetWorkflowExecution],
		["fabric_execute_workflow", handleExecuteWorkflow],
		["fabric_create_workflow", handleCreateWorkflow],
		["fabric_update_workflow", handleUpdateWorkflow],
		["fabric_publish_workflow", handlePublishWorkflow],
		["fabric_unpublish_workflow", handleUnpublishWorkflow],
		["fabric_pause_workflow", handlePauseWorkflow],
		["fabric_resume_workflow", handleResumeWorkflow],
	]);

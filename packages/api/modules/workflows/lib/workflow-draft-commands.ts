/**
 * Creating and editing a scheduled-agent workflow with a draft in between.
 *
 * What the Fabric Agent does for a person: it builds the graph from a preset (or
 * takes the one it was given), shows a draft of what would be saved and what
 * would stop it going live, and writes only once that is confirmed. The draft is
 * derived from the very graph that would be saved, with the checks publishing
 * itself runs, so what a person confirms is what is stored.
 *
 * Like every command these take an explicit actor and refuse with a
 * `WorkflowCommandError`; the gateway tools only map their arguments onto them.
 */

import {
	db,
	isWorkflowLive,
	listMcpConfigRoutingForTenant,
	type Prisma,
} from "@repo/database";
import {
	AgentTaskToFramePresetSchema,
	applyPresetPatch,
	buildAgentTaskToFramePreset,
	type PresetCreateArgs,
	type PresetPatch,
	type PresetUpdateArgs,
	readGraphFacts,
	type WorkflowDraft,
	WorkflowDraftSchema,
} from "@repo/temporal/agentic-workflow-preset";
import { findAgenticPublishProblems } from "./agentic-publish-validation";
import {
	loadEditableWorkflow,
	requireWritableProject,
	WorkflowCommandError,
	type WorkflowActor,
} from "./workflow-command-context";
import {
	applyWorkflowUpdate,
	assertMayCreateWorkflow,
	insertWorkflow,
} from "./workflow-commands";
import { describeWorkflowSchedule } from "./workflow-schedule-description";

/** What a draft is built from: the workflow as it would be saved. */
export interface WorkflowSpec {
	name: string;
	description?: string;
	nodes: unknown[];
	edges: unknown[];
	projectId?: string;
}

/** JSON-safe copy of a value, for the Prisma JSON columns. */
function toJson(value: unknown): Prisma.InputJsonValue {
	return JSON.parse(JSON.stringify(value));
}

function asList(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * The project a draft names, when the actor may place the workflow in it. A
 * project that fails that rule is left out of the draft; the problems say why.
 */
async function draftProject(actor: WorkflowActor, projectId: string) {
	try {
		await requireWritableProject(actor, projectId);
	} catch (error) {
		if (error instanceof WorkflowCommandError) {
			return null;
		}
		throw error;
	}
	return db.project.findUnique({
		where: { id: projectId },
		select: { id: true, name: true },
	});
}

/**
 * What the person is asked to confirm: the schedule in words, the prompt, the
 * servers and tools the agent may use, where its page goes, and everything
 * that would stop it going live. The problems are `findAgenticPublishProblems`'
 * and only those, so a draft says what a publish would refuse, once; the rest
 * is lookups for display.
 */
export async function buildWorkflowDraft(
	actor: WorkflowActor,
	spec: WorkflowSpec,
): Promise<WorkflowDraft> {
	const facts = readGraphFacts(spec.nodes);
	const projectId = facts.publish?.projectId ?? spec.projectId ?? null;
	const [{ problems, mcpServers }, project] = await Promise.all([
		findAgenticPublishProblems({
			nodes: spec.nodes,
			userId: actor.userId,
			organizationId: actor.organizationId,
			projectId,
		}),
		projectId ? draftProject(actor, projectId) : null,
	]);
	return WorkflowDraftSchema.parse({
		kind: "workflow",
		name: spec.name,
		description: spec.description ?? null,
		schedule: describeWorkflowSchedule(spec.nodes),
		prompt: facts.agent?.prompt ?? null,
		mcpServers,
		builtInTools: facts.agent?.builtInToolNames ?? [],
		project,
		outputTitle: facts.publish?.title ?? null,
		outputFormat: facts.agent?.outputFormat ?? null,
		steps: facts.steps,
		problems,
	});
}

/**
 * Resolves server names the way people say them ("Azure DevOps") to the ids of
 * the caller's own connections, so the model never has to know an id. An id
 * passes through; a name that matches none or several is refused with the
 * names that would work.
 */
async function resolveMcpServerRefs(
	actor: WorkflowActor,
	names: readonly string[],
	ids: readonly string[],
): Promise<string[]> {
	if (names.length === 0) {
		return [...ids];
	}
	const configs = await listMcpConfigRoutingForTenant(actor);
	const normalize = (value: string) =>
		value.toLowerCase().replace(/[^a-z0-9]/g, "");
	const resolved = new Set(ids);
	for (const name of names) {
		const byId = configs.find((config) => config.id === name);
		const matches = byId
			? [byId]
			: configs.filter(
					(config) =>
						normalize(config.displayName ?? "") ===
							normalize(name) ||
						normalize(config.mcpServer?.name ?? "") ===
							normalize(name),
				);
		if (matches.length !== 1) {
			const available = configs
				.map((config) => config.displayName ?? config.mcpServer?.name)
				.filter((value): value is string => Boolean(value));
			throw new WorkflowCommandError(
				"BAD_REQUEST",
				`${matches.length === 0 ? "No connected server matches" : "Several connected servers match"} "${name}". Your connected servers: ${available.join(", ") || "none"}.`,
			);
		}
		resolved.add(matches[0].id);
	}
	return [...resolved];
}

/** The outcome of a create or edit: the draft, and the workflow once it was written. */
export type DraftedOutcome<Written> =
	| { written: false; draft: WorkflowDraft }
	| { written: true; draft: WorkflowDraft; workflow: Written };

async function createDrafted(
	actor: WorkflowActor,
	spec: WorkflowSpec,
	dryRun: boolean | undefined,
) {
	// Refuse where the real create would, before any draft is built.
	await assertMayCreateWorkflow(actor, spec.projectId);
	const draft = await buildWorkflowDraft(actor, spec);
	if (dryRun) {
		return { written: false, draft } as const;
	}
	const workflow = await insertWorkflow(actor, {
		name: spec.name,
		description: spec.description,
		triggerType: readGraphFacts(spec.nodes).schedule
			? "SCHEDULE"
			: "MANUAL",
		nodes: toJson(spec.nodes),
		edges: toJson(spec.edges),
		projectId: spec.projectId,
	});
	return { written: true, draft, workflow } as const;
}

/**
 * Creates a scheduled agent workflow from a preset: the graph is built, not
 * generated. The project is the preset's, else `projectId`, else
 * `defaultProjectId` (the one the caller is working in).
 */
export async function createWorkflowFromPresetCommand(
	actor: WorkflowActor,
	input: {
		preset: PresetCreateArgs;
		projectId?: string;
		defaultProjectId?: string;
		dryRun?: boolean;
	},
) {
	const { mcpServers, mcpConfigIds, ...rest } = input.preset;
	const complete = AgentTaskToFramePresetSchema.safeParse({
		...rest,
		outputTitle: rest.outputTitle ?? rest.name,
		mcpConfigIds: await resolveMcpServerRefs(
			actor,
			mcpServers ?? [],
			mcpConfigIds ?? [],
		),
		projectId: rest.projectId ?? input.projectId ?? input.defaultProjectId,
	});
	if (!complete.success) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			complete.error.issues
				.map(
					(issue) =>
						`preset.${issue.path.join(".")}: ${issue.message}`,
				)
				.join("; "),
		);
	}
	const graph = buildAgentTaskToFramePreset(complete.data);
	return createDrafted(
		actor,
		{
			name: complete.data.name,
			description: complete.data.description,
			nodes: graph.nodes,
			edges: graph.edges,
			projectId: complete.data.projectId,
		},
		input.dryRun,
	);
}

/** Creates a workflow from a graph the caller built. */
export function createWorkflowFromGraphCommand(
	actor: WorkflowActor,
	input: WorkflowSpec & { dryRun?: boolean },
) {
	const { dryRun, ...spec } = input;
	return createDrafted(actor, spec, dryRun);
}

/** The preset's edit as a patch: servers named by name become connection ids. */
async function presetPatch(
	actor: WorkflowActor,
	preset: PresetUpdateArgs,
): Promise<PresetPatch> {
	const { mcpServers, ...patch } = preset;
	if (mcpServers === undefined && patch.mcpConfigIds === undefined) {
		return patch;
	}
	return {
		...patch,
		mcpConfigIds: await resolveMcpServerRefs(
			actor,
			mcpServers ?? [],
			patch.mcpConfigIds ?? [],
		),
	};
}

/**
 * Edits a workflow with a draft in between: `preset` changes fields of its
 * scheduled-agent graph, `nodes` and `edges` replace the graph. The workflow is
 * loaded once and handed to the update, so an edit reads it a single time.
 */
export async function updateWorkflowWithDraftCommand(
	actor: WorkflowActor,
	input: {
		workflowId: string;
		name?: string;
		description?: string;
		preset?: PresetUpdateArgs;
		nodes?: unknown[];
		edges?: unknown[];
		dryRun?: boolean;
	},
) {
	const current = await loadEditableWorkflow(actor, input.workflowId, "edit");

	let nodes = input.nodes;
	if (input.preset) {
		const applied = applyPresetPatch(
			current.nodes,
			await presetPatch(actor, input.preset),
		);
		if (!applied.ok) {
			throw new WorkflowCommandError("BAD_REQUEST", applied.error);
		}
		nodes = applied.nodes;
	}

	const draft = await buildWorkflowDraft(actor, {
		name: input.name ?? current.name,
		description: input.description ?? current.description ?? undefined,
		nodes: nodes ?? asList(current.nodes),
		edges: input.edges ?? asList(current.edges),
		projectId: current.projectId ?? undefined,
	});
	if (input.dryRun) {
		return { written: false, draft } as const;
	}

	const workflow = await applyWorkflowUpdate(actor, current, {
		id: current.id,
		name: input.name,
		description: input.description,
		nodes: nodes === undefined ? undefined : toJson(nodes),
		edges: input.edges === undefined ? undefined : toJson(input.edges),
	});
	return {
		written: true,
		draft,
		workflow,
		/** The edit changed a workflow that is already running on its schedule. */
		live: isWorkflowLive(workflow.status),
	} as const;
}

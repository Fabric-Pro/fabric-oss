/**
 * The agent-task and publish-frame workflow-builder nodes, and the preset graph
 * that chains them behind a schedule trigger ("every Monday, ask an agent,
 * publish what it wrote as a frame").
 *
 * Everything that knows the shape of that graph lives here, so it is declared
 * once: the node configs, the preset and the patch a later edit may apply to
 * it, how a stored graph is read back, the draft a person is shown before
 * anything is written, and the zod arguments the MCP tools accept. Shared by the
 * step implementations (`activities/lib/steps/agent-task.ts`,
 * `publish-frame.ts`), publish-time validation, the workflow commands and the
 * gateway tools. No I/O, so the web app can import it through
 * `@repo/temporal/agentic-workflow-preset`.
 */

import { FRAME_SURFACES } from "@repo/utils/frame-surfaces";
import { z } from "zod";
import {
	findScheduleCron,
	findScheduleTimezone,
} from "../schedules/workflow-builder-schedule";
import {
	AGENT_TASK_NODE_TYPE,
	PUBLISH_FRAME_NODE_TYPE,
} from "./workflow-node-types";

export { FRAME_SURFACES, type FrameSurface } from "@repo/utils/frame-surfaces";
export {
	AGENT_TASK_NODE_TYPE,
	PUBLISH_FRAME_NODE_TYPE,
} from "./workflow-node-types";

export const TRIGGER_NODE_TYPE = "trigger";

export const AGENT_TASK_MAX_ITERATIONS = 10;

/** Shortest interval a published schedule may fire at. */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 15;

export const AgentTaskNodeConfigSchema = z.object({
	prompt: z.string().trim().min(1).max(20_000),
	systemPrompt: z.string().max(20_000).optional(),
	modelId: z.string().min(1).optional(),
	/** The publishing user's own MCP configurations the agent may call. */
	mcpConfigIds: z.array(z.string().min(1)).max(10).default([]),
	/** Built-in capability ids from the agent tool map (e.g. "project-context"). */
	builtInToolNames: z.array(z.string().min(1)).max(30).default([]),
	maxIterations: z
		.number()
		.int()
		.min(1)
		.max(AGENT_TASK_MAX_ITERATIONS)
		.default(AGENT_TASK_MAX_ITERATIONS),
	outputFormat: z.enum(["html", "markdown"]).default("html"),
});
export type AgentTaskNodeConfig = z.infer<typeof AgentTaskNodeConfigSchema>;

export const PublishFrameNodeConfigSchema = z.object({
	title: z.string().trim().min(1).max(200),
	description: z.string().max(2_000).optional(),
	/** Template resolved against upstream outputs, e.g. `{{Agent Task.html}}`. */
	content: z.string().min(1),
	format: z.enum(["html", "markdown"]).default("html"),
	/** Defaults to the workflow's project when omitted. */
	projectId: z.string().min(1).optional(),
	surface: z.enum(FRAME_SURFACES).default("artifact"),
	/**
	 * `new-version` keeps one frame per workflow and adds a version on each run;
	 * `new-frame` creates a fresh frame every run.
	 */
	mode: z.enum(["new-version", "new-frame"]).default("new-version"),
});
export type PublishFrameNodeConfig = z.infer<
	typeof PublishFrameNodeConfigSchema
>;

export const AgentTaskToFramePresetSchema = z.object({
	name: z.string().trim().min(1).max(255),
	description: z.string().max(2_000).optional(),
	cron: z.string().trim().min(1),
	/** IANA time zone the cron is read in, e.g. "Europe/Berlin". */
	timezone: z.string().trim().min(1).default("UTC"),
	prompt: AgentTaskNodeConfigSchema.shape.prompt,
	mcpConfigIds: AgentTaskNodeConfigSchema.shape.mcpConfigIds,
	builtInToolNames: AgentTaskNodeConfigSchema.shape.builtInToolNames,
	modelId: AgentTaskNodeConfigSchema.shape.modelId,
	maxIterations: AgentTaskNodeConfigSchema.shape.maxIterations,
	outputTitle: z.string().trim().min(1).max(200),
	outputFormat: AgentTaskNodeConfigSchema.shape.outputFormat,
	projectId: z.string().min(1).optional(),
});
export type AgentTaskToFramePreset = z.input<
	typeof AgentTaskToFramePresetSchema
>;

export const AGENT_TASK_NODE_LABEL = "Agent Task";
export const PUBLISH_FRAME_NODE_LABEL = "Publish Frame";

/** The Publish Frame template that reads what the agent step produced in `format`. */
function publishContent(format: "html" | "markdown"): string {
	return `{{${AGENT_TASK_NODE_LABEL}.${format}}}`;
}

export interface PresetGraphNode {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: { label: string; config: Record<string, unknown> };
}

export interface PresetGraphEdge {
	id: string;
	source: string;
	target: string;
}

/**
 * Builds the three-node graph `trigger(schedule) → agent-task → publish-frame`
 * in the React Flow shape the builder stores and `findScheduleCron` reads.
 * Deterministic: no LLM is involved in producing the graph.
 */
export function buildAgentTaskToFramePreset(input: AgentTaskToFramePreset): {
	nodes: PresetGraphNode[];
	edges: PresetGraphEdge[];
} {
	const preset = AgentTaskToFramePresetSchema.parse(input);
	const agentConfig = AgentTaskNodeConfigSchema.parse({
		prompt: preset.prompt,
		modelId: preset.modelId,
		mcpConfigIds: preset.mcpConfigIds,
		builtInToolNames: preset.builtInToolNames,
		maxIterations: preset.maxIterations,
		outputFormat: preset.outputFormat,
	});
	const publishConfig = PublishFrameNodeConfigSchema.parse({
		title: preset.outputTitle,
		content: publishContent(agentConfig.outputFormat),
		format: agentConfig.outputFormat,
		projectId: preset.projectId,
	});

	return {
		nodes: [
			{
				id: "trigger",
				type: TRIGGER_NODE_TYPE,
				position: { x: 0, y: 0 },
				data: {
					label: "Schedule",
					config: {
						triggerType: "schedule",
						scheduleCron: preset.cron,
						scheduleTimezone: preset.timezone,
					},
				},
			},
			{
				id: "agent-task",
				type: AGENT_TASK_NODE_TYPE,
				position: { x: 0, y: 160 },
				data: { label: AGENT_TASK_NODE_LABEL, config: agentConfig },
			},
			{
				id: "publish-frame",
				type: PUBLISH_FRAME_NODE_TYPE,
				position: { x: 0, y: 320 },
				data: {
					label: PUBLISH_FRAME_NODE_LABEL,
					config: publishConfig,
				},
			},
		],
		edges: [
			{
				id: "trigger-agent-task",
				source: "trigger",
				target: "agent-task",
			},
			{
				id: "agent-task-publish-frame",
				source: "agent-task",
				target: "publish-frame",
			},
		],
	};
}

// ─── Reading a stored graph ──────────────────────────────────────────────────

/**
 * A node as the builder stored it: only what is read here is typed, and
 * everything else the builder saved (selection, size, a step's own fields)
 * rides along untouched.
 */
const StoredNodeSchema = z.looseObject({
	id: z.unknown().optional(),
	type: z.string().optional(),
	data: z
		.looseObject({
			label: z.unknown().optional(),
			config: z.record(z.string(), z.unknown()).optional(),
		})
		.optional(),
});
type StoredNode = z.infer<typeof StoredNodeSchema>;

function storedNodes(nodes: unknown): StoredNode[] {
	if (!Array.isArray(nodes)) {
		return [];
	}
	return nodes.flatMap((node) => {
		const parsed = StoredNodeSchema.safeParse(node);
		return parsed.success ? [parsed.data] : [];
	});
}

function configOf(node: StoredNode): Record<string, unknown> {
	return node.data?.config ?? {};
}

function stepLabel(node: StoredNode): string {
	if (typeof node.data?.label === "string" && node.data.label.trim()) {
		return node.data.label;
	}
	return typeof node.id === "string" ? node.id : (node.type ?? "unknown");
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export interface GraphFacts {
	schedule: { cron: string; timezone: string } | null;
	agent: {
		prompt: string | null;
		mcpConfigIds: string[];
		builtInToolNames: string[];
		outputFormat: string | null;
	} | null;
	publish: { title: string | null; projectId: string | null } | null;
	steps: Array<{ type: string; label: string; settings: string | null }>;
}

const STEP_SETTING_CHARS = 160;
const STEP_SETTINGS_CHARS = 600;

/**
 * A step's own settings in plain text: every scalar or list of scalars in its
 * config, each value shortened. A label is the author's word for a step, and
 * the author may be a model that read something nobody vetted, so what a person
 * approves has to show what each step does: the URL it calls, the tool it runs
 * with which arguments, who it writes to.
 */
function stepSettings(config: Record<string, unknown>): string | null {
	const shorten = (text: string) =>
		text.length > STEP_SETTING_CHARS
			? `${text.slice(0, STEP_SETTING_CHARS)}…`
			: text;
	const parts: string[] = [];
	for (const [key, value] of Object.entries(config)) {
		const values = Array.isArray(value) ? value : [value];
		if (
			values.length === 0 ||
			!values.every(
				(item) =>
					typeof item === "string" ||
					typeof item === "number" ||
					typeof item === "boolean",
			)
		) {
			continue;
		}
		parts.push(`${key}: ${shorten(values.map(String).join(", "))}`);
	}
	const text = parts.join(" · ");
	if (!text) {
		return null;
	}
	return text.length > STEP_SETTINGS_CHARS
		? `${text.slice(0, STEP_SETTINGS_CHARS)}…`
		: text;
}

/**
 * What a person needs to know about a stored scheduled-agent graph: when it
 * runs, what the agent is told and may use, where its page goes, and the steps
 * in order. The schedule is read the way the schedule sync reads it, so a draft
 * never describes a different cron than the one that would fire.
 */
export function readGraphFacts(nodes: unknown): GraphFacts {
	const cron = findScheduleCron(nodes);
	const facts: GraphFacts = {
		schedule: cron
			? { cron, timezone: findScheduleTimezone(nodes) ?? "UTC" }
			: null,
		agent: null,
		publish: null,
		steps: [],
	};
	for (const node of storedNodes(nodes)) {
		const type = node.type ?? "unknown";
		const config = configOf(node);
		facts.steps.push({
			type,
			label: stepLabel(node),
			settings: stepSettings(config),
		});
		if (type === AGENT_TASK_NODE_TYPE && facts.agent === null) {
			facts.agent = {
				prompt: stringOrNull(config.prompt),
				mcpConfigIds: stringList(config.mcpConfigIds),
				builtInToolNames: stringList(config.builtInToolNames),
				outputFormat: stringOrNull(config.outputFormat),
			};
		} else if (type === PUBLISH_FRAME_NODE_TYPE && facts.publish === null) {
			facts.publish = {
				title: stringOrNull(config.title),
				projectId: stringOrNull(config.projectId),
			};
		}
	}
	return facts;
}

const APPROVAL_PROMPT_CHARS = 1_000;

/**
 * What a create or update call would save, for an approval that sees only the
 * call's arguments: the Orchestrator asks before the tool runs, so unlike the
 * Direct chat it has no draft to show. Lists every step with its settings and
 * the agent's prompt; null when the call carries no graph (a patch that only
 * renames, for one).
 */
export function describeWorkflowCall(
	args: Record<string, unknown> | undefined,
): string | null {
	const nodes = Array.isArray(args?.nodes)
		? args.nodes
		: presetNodes(args?.preset);
	if (!nodes) {
		return null;
	}
	const facts = readGraphFacts(nodes);
	if (facts.steps.length === 0) {
		return null;
	}
	const lines = [
		"Steps:",
		...facts.steps.map(
			(step, index) =>
				`${index + 1}. ${step.label} (${step.type})${step.settings ? `: ${step.settings}` : ""}`,
		),
	];
	const prompt = facts.agent?.prompt;
	if (prompt) {
		lines.push(
			"",
			"Agent prompt:",
			prompt.length > APPROVAL_PROMPT_CHARS
				? `${prompt.slice(0, APPROVAL_PROMPT_CHARS)}…`
				: prompt,
		);
	}
	return lines.join("\n");
}

/** The graph a `preset` builds, filled in the way the create command fills it. */
function presetNodes(preset: unknown): PresetGraphNode[] | null {
	const parsed = PresetCreateArgsSchema.safeParse(preset);
	if (!parsed.success) {
		return null;
	}
	const { mcpServers: _, ...fields } = parsed.data;
	return buildAgentTaskToFramePreset({
		...fields,
		outputTitle: fields.outputTitle ?? fields.name,
	}).nodes;
}

// ─── Patching a stored graph ─────────────────────────────────────────────────

const patchable = AgentTaskToFramePresetSchema.omit({
	name: true,
	description: true,
}).shape;

/**
 * The parts of a preset a later edit may change; `name` and `description` are
 * the workflow's own and are applied by the caller. Built from the preset's
 * field schemas with their defaults removed: a patch field left out means
 * "keep what is there", and a default would turn every omission into a change.
 */
export const PresetPatchSchema = z.object({
	cron: patchable.cron.optional(),
	timezone: patchable.timezone.unwrap().optional(),
	prompt: patchable.prompt.optional(),
	mcpConfigIds: patchable.mcpConfigIds.unwrap().optional(),
	builtInToolNames: patchable.builtInToolNames.unwrap().optional(),
	modelId: patchable.modelId,
	maxIterations: patchable.maxIterations.unwrap().optional(),
	outputTitle: patchable.outputTitle.optional(),
	outputFormat: patchable.outputFormat.unwrap().optional(),
	projectId: patchable.projectId,
});
export type PresetPatch = z.infer<typeof PresetPatchSchema>;

/** Where each patch field lands: the step it belongs to and its config key. */
const PATCH_TARGETS = {
	cron: [{ step: TRIGGER_NODE_TYPE, key: "scheduleCron" }],
	timezone: [{ step: TRIGGER_NODE_TYPE, key: "scheduleTimezone" }],
	prompt: [{ step: AGENT_TASK_NODE_TYPE, key: "prompt" }],
	mcpConfigIds: [{ step: AGENT_TASK_NODE_TYPE, key: "mcpConfigIds" }],
	builtInToolNames: [{ step: AGENT_TASK_NODE_TYPE, key: "builtInToolNames" }],
	modelId: [{ step: AGENT_TASK_NODE_TYPE, key: "modelId" }],
	maxIterations: [{ step: AGENT_TASK_NODE_TYPE, key: "maxIterations" }],
	outputFormat: [
		{ step: AGENT_TASK_NODE_TYPE, key: "outputFormat" },
		{ step: PUBLISH_FRAME_NODE_TYPE, key: "format" },
	],
	outputTitle: [{ step: PUBLISH_FRAME_NODE_TYPE, key: "title" }],
	projectId: [{ step: PUBLISH_FRAME_NODE_TYPE, key: "projectId" }],
} as const satisfies Record<
	keyof PresetPatch,
	ReadonlyArray<{ step: string; key: string }>
>;

const MISSING_STEP: Readonly<Record<string, string>> = {
	[TRIGGER_NODE_TYPE]: "This workflow has no trigger step to change",
	[AGENT_TASK_NODE_TYPE]:
		"This workflow has no agent step; send nodes and edges instead of a preset",
	[PUBLISH_FRAME_NODE_TYPE]:
		"This workflow has no publish step; send nodes and edges instead of a preset",
};

type PresetPatchResult =
	| { ok: true; nodes: unknown[] }
	| { ok: false; error: string };

function describeIssues(
	label: string,
	issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
	return issues
		.map(
			(issue) =>
				`${label}: ${issue.path.map(String).join(".") || "config"} — ${issue.message}`,
		)
		.join("; ");
}

/**
 * Applies `patch` to the preset-shaped graph (trigger, agent step, publish
 * step). A graph without the step a field belongs to is refused rather than
 * patched somewhere else, so a change never lands on a step the person did not
 * mean. The patched agent and publish configs must still satisfy their schemas.
 */
export function applyPresetPatch(
	nodes: unknown,
	patch: PresetPatch,
): PresetPatchResult {
	const values: Record<string, unknown> = patch;
	const writes = new Map<string, Record<string, unknown>>();
	const write = (step: string, config: Record<string, unknown>) => {
		writes.set(step, { ...writes.get(step), ...config });
	};
	for (const [field, targets] of Object.entries(PATCH_TARGETS)) {
		const value = values[field];
		if (value !== undefined) {
			for (const { step, key } of targets) {
				write(step, { [key]: value });
			}
		}
	}
	if (patch.outputFormat !== undefined) {
		write(PUBLISH_FRAME_NODE_TYPE, {
			content: publishContent(patch.outputFormat),
		});
	}
	if (writes.has(TRIGGER_NODE_TYPE)) {
		write(TRIGGER_NODE_TYPE, { triggerType: "schedule" });
	}

	const list = Array.isArray(nodes) ? nodes : [];
	const typeOf = (node: unknown): string | undefined => {
		const parsed = StoredNodeSchema.safeParse(node);
		return parsed.success ? parsed.data.type : undefined;
	};
	for (const step of writes.keys()) {
		if (!list.some((node) => typeOf(node) === step)) {
			return { ok: false, error: MISSING_STEP[step] ?? "Step not found" };
		}
	}

	const patchedSteps = new Set<string>();
	const patched = list.map((node) => {
		const parsed = StoredNodeSchema.safeParse(node);
		const step = parsed.success ? parsed.data.type : undefined;
		const config = step ? writes.get(step) : undefined;
		if (!(parsed.success && step && config) || patchedSteps.has(step)) {
			return node;
		}
		patchedSteps.add(step);
		return {
			...parsed.data,
			data: {
				...parsed.data.data,
				config: { ...configOf(parsed.data), ...config },
			},
		};
	});

	const problems = storedNodes(patched).flatMap((node) => {
		if (node.type === AGENT_TASK_NODE_TYPE) {
			const checked = AgentTaskNodeConfigSchema.safeParse(configOf(node));
			return checked.success
				? []
				: [describeIssues("Agent step", checked.error.issues)];
		}
		if (node.type === PUBLISH_FRAME_NODE_TYPE) {
			const checked = PublishFrameNodeConfigSchema.safeParse(
				configOf(node),
			);
			return checked.success
				? []
				: [describeIssues("Publish step", checked.error.issues)];
		}
		return [];
	});
	return problems.length > 0
		? { ok: false, error: problems.join("; ") }
		: { ok: true, nodes: patched };
}

// ─── What the MCP tools accept and show ──────────────────────────────────────

/**
 * Connections named the way people say them ("Azure DevOps"); the gateway
 * resolves them to the caller's own connection ids so a model never needs one.
 */
const McpServerNames = z.array(z.string().min(1)).max(10);

/** `preset` of `fabric_create_workflow`: the preset, with the title and servers friendlier. */
export const PresetCreateArgsSchema = AgentTaskToFramePresetSchema.extend({
	outputTitle: AgentTaskToFramePresetSchema.shape.outputTitle.optional(),
	mcpServers: McpServerNames.optional(),
});
export type PresetCreateArgs = z.input<typeof PresetCreateArgsSchema>;

/** `preset` of `fabric_update_workflow`: the fields to change. */
export const PresetUpdateArgsSchema = PresetPatchSchema.extend({
	mcpServers: McpServerNames.optional(),
});
export type PresetUpdateArgs = z.infer<typeof PresetUpdateArgsSchema>;

/**
 * What a person is asked to confirm, derived from the graph that would be
 * saved: the schedule in words, the prompt, the servers and tools the agent
 * may use, where its page goes, and everything that would stop it going live.
 */
export const WorkflowDraftSchema = z.object({
	kind: z.literal("workflow"),
	name: z.string(),
	description: z.string().nullable(),
	schedule: z
		.object({
			cron: z.string(),
			timezone: z.string(),
			description: z.string(),
		})
		.nullable(),
	prompt: z.string().nullable(),
	mcpServers: z.array(z.object({ configId: z.string(), name: z.string() })),
	builtInTools: z.array(z.string()),
	project: z.object({ id: z.string(), name: z.string() }).nullable(),
	outputTitle: z.string().nullable(),
	outputFormat: z.string().nullable(),
	steps: z.array(
		z.object({
			type: z.string(),
			label: z.string(),
			settings: z.string().nullable(),
		}),
	),
	problems: z.array(z.string()),
});
export type WorkflowDraft = z.infer<typeof WorkflowDraftSchema>;

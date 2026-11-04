export { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";

import { parseYamlSafe, stringifyYaml } from "@repo/utils/safe-yaml";
import { z } from "zod";

export const PORTABLE_SKILL_PATH = /^skills\/[a-zA-Z0-9_-]+\/SKILL\.md$/;

export const MAX_AGENT_DEFINITION_BYTES = 1024 * 1024;
const text = z.string().max(100_000);
const modelPolicySchema = z.strictObject({
	model: z.string().min(1).max(200).optional(),
	temperature: z.number().min(0).max(2).optional(),
	topP: z.number().min(0).max(1).optional(),
	maxTokens: z.number().int().positive().max(1_000_000).optional(),
});
const requirementSchema = z.strictObject({
	kind: z.enum(["tool", "mcp", "integration", "knowledge", "trigger"]),
	name: z.string().min(1).max(200),
});
const requirementsSchema = z.array(requirementSchema).max(500);

/** Portable intent only. Connection IDs, credentials and approvals are not grants. */
const legacyAgentDefinitionSchema = z.strictObject({
	apiVersion: z.literal("fabric.ai/v1"),
	kind: z.literal("Agent"),
	name: z.string().trim().min(1).max(200),
	description: z.string().max(500),
	instructions: z.strictObject({
		template: text,
		role: text.optional(),
		additionalContext: text.optional(),
		constraints: text.optional(),
		starterMessages: z.array(z.string().max(2_000)).max(20).optional(),
	}),
	model: modelPolicySchema,
	execution: z
		.strictObject({
			mode: z.enum(["single_turn", "goal_oriented"]),
			goal: z.string().min(1).max(2_000).optional(),
			maxIterations: z.number().int().min(1).max(50),
			successCriteria: z
				.strictObject({
					type: z.enum([
						"llm_judge",
						"output_contains",
						"tool_success",
						"custom",
					]),
					evaluationPrompt: text.optional(),
					requiredOutputs: z
						.array(z.string().max(2_000))
						.max(100)
						.optional(),
					requiredTools: z
						.array(z.string().max(200))
						.max(100)
						.optional(),
					confidenceThreshold: z.number().min(0).max(1).optional(),
				})
				.optional(),
		})
		.refine((value) => value.mode !== "goal_oriented" || !!value.goal, {
			message: "Goal-oriented agents require a goal",
			path: ["goal"],
		}),
	skills: z
		.array(
			z.strictObject({
				path: z.string().regex(PORTABLE_SKILL_PATH),
				content: text,
				enabled: z.boolean(),
			}),
		)
		.max(100)
		.refine(
			(skills) =>
				new Set(skills.map((skill) => skill.path)).size ===
				skills.length,
			{
				message: "Skill paths must be unique",
			},
		),
	requirements: requirementsSchema,
});
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const exactVersionSchema = z
	.string()
	.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const portablePathSchema = z
	.string()
	.min(1)
	.max(300)
	.refine(
		(path) =>
			!path.startsWith("/") &&
			!path.includes("\\") &&
			path
				.split("/")
				.every((part) => !!part && part !== "." && part !== "..") &&
			/^[a-zA-Z0-9_./-]+$/.test(path),
		"Use an explicit artifact-relative path without traversal",
	);
const artifactSchema = z.strictObject({
	digest: digestSchema,
	repository: z.strictObject({
		url: z
			.string()
			.url()
			.max(1000)
			.refine((value) => {
				const url = new URL(value);
				return (
					url.protocol === "https:" &&
					!url.username &&
					!url.password &&
					!url.search &&
					!url.hash
				);
			}, "Use an HTTPS repository URL without credentials or query parameters"),
		revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
	}),
	packages: z.strictObject({
		sdk: z.strictObject({
			name: z.literal("@fabric-harness/sdk"),
			version: exactVersionSchema,
			entrypoint: z.literal("strict"),
		}),
		node: z.strictObject({
			name: z.literal("@fabric-harness/node"),
			version: exactVersionSchema,
		}),
		client: z
			.strictObject({
				name: z.literal("@fabric-harness/client"),
				version: exactVersionSchema,
			})
			.optional(),
	}),
	buildManifestVersion: z.literal(2),
});
const schemaReference = z.strictObject({
	path: portablePathSchema,
	digest: digestSchema,
});
const harnessShape = {
	artifact: artifactSchema,
	entrypoint: z.strictObject({
		module: portablePathSchema,
		export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,199}$/),
		identity: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/),
	}),
	protocol: z.strictObject({
		// An exact release requirement, not a claim that a runtime was qualified.
		generation: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/),
		interface: z.enum(["finite_job", "persistent_submission", "responses"]),
	}),
	schemas: z.strictObject({
		input: schemaReference,
		output: schemaReference,
		initialData: schemaReference.optional(),
	}),
};
const agentImplementationSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("native") }),
		z.strictObject({ kind: z.literal("harness_finite"), ...harnessShape }),
		z.strictObject({
			kind: z.literal("harness_persistent"),
			...harnessShape,
		}),
	])
	.superRefine((value, context) => {
		if (value.kind === "native") {
			return;
		}
		if (
			(value.kind === "harness_finite") !==
			(value.protocol.interface === "finite_job")
		) {
			context.addIssue({
				code: "custom",
				path: ["protocol", "interface"],
				message:
					"Implementation kind and protocol interface must agree",
			});
		}
		if (value.kind === "harness_finite" && value.schemas.initialData) {
			context.addIssue({
				code: "custom",
				path: ["schemas", "initialData"],
				message:
					"Initial instance data belongs to persistent implementations",
			});
		}
	});
const logicalBindingsSchema = z
	.array(
		z.strictObject({
			name: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
			kind: z.enum([
				"tool",
				"mcp",
				"integration",
				"knowledge",
				"project",
				"model",
				"trigger",
			]),
			required: z.boolean(),
			operations: z
				.array(z.string().regex(/^[a-z][a-z0-9_.:-]{0,99}$/))
				.max(100),
		}),
	)
	.max(500)
	.refine(
		(bindings) =>
			new Set(bindings.map((binding) => binding.name)).size ===
			bindings.length,
		"Logical binding names must be unique",
	);
const currentAgentDefinitionSchema = legacyAgentDefinitionSchema.extend({
	apiVersion: z.literal("fabric.ai/v2"),
	implementation: agentImplementationSchema,
	logicalBindings: logicalBindingsSchema,
	expectedOutput: z.string().trim().max(4000).optional(),
});
const agentDefinitionSchema = z.union([
	legacyAgentDefinitionSchema,
	currentAgentDefinitionSchema,
]);
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type CurrentAgentDefinition = z.infer<
	typeof currentAgentDefinitionSchema
>;
const PORTABLE_IMPLEMENTATION_KEYS = [
	"portableImplementation",
	"portableBindings",
	"portableDefinitionVersion",
] as const;

/** Generic configuration commands cannot mint a code release or change its code-owned intent. */
export function assertAgentDefinitionConfigUpdate(
	previousCustomInstructions: unknown,
	input: Record<string, unknown>,
): void {
	const next = record(input.customInstructions);
	if (PORTABLE_IMPLEMENTATION_KEYS.some((key) => Object.hasOwn(next, key))) {
		throw new Error(
			"Implementation release metadata can only be changed by importing a reviewed agent definition.",
		);
	}
	const previous = record(previousCustomInstructions);
	const implementation = previous.portableImplementation;
	if (
		implementation === undefined ||
		(agentImplementationSchema.safeParse(implementation).success &&
			record(implementation).kind === "native")
	) {
		return;
	}
	// These are executable source fields. Even an equal-looking generic write cannot
	// prove it came from the pinned artifact; rebuild/import is the release boundary.
	const sourceFields = [
		"customInstructions",
		"modelOverride",
		"modelConfig",
		"executionMode",
		"goal",
		"successCriteria",
		"maxIterations",
		"toolConnections",
		"knowledgeConnections",
		"knowledgeResources",
		"workspaceIds",
		"triggers",
	];
	if (sourceFields.some((key) => input[key] !== undefined)) {
		throw new Error(
			"Code-owned agent configuration is read-only. Rebuild and import a new implementation release to change it.",
		);
	}
}
export type AgentDefinitionFormat = "json" | "yaml";

export function parseAgentDefinition(document: string): AgentDefinition {
	// YAML core also accepts JSON; unique-key checking covers both syntaxes.
	return agentDefinitionSchema.parse(
		parseYamlSafe(document, {
			maxBytes: MAX_AGENT_DEFINITION_BYTES,
			maxDepth: 15,
			maxAliasCount: 0,
			uniqueKeys: true,
		}),
	);
}

export function serializeAgentDefinition(
	definition: AgentDefinition,
	format: AgentDefinitionFormat,
): string {
	const validated = agentDefinitionSchema.parse(definition);
	const document =
		format === "yaml"
			? stringifyYaml(validated)
			: `${JSON.stringify(validated, null, 2)}\n`;
	if (Buffer.byteLength(document, "utf8") > MAX_AGENT_DEFINITION_BYTES) {
		throw new Error("Agent definition exceeds the 1 MB limit");
	}
	return document;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
}

export interface AgentDefinitionSource {
	name: string;
	description: string | null;
	template: {
		instructions: string;
		suggestedModel: string | null;
		modelConfig: unknown;
	};
	customInstructions: unknown;
	modelOverride: string | null;
	modelConfig: unknown;
	executionMode: string;
	goal: string | null;
	maxIterations: number;
	successCriteria: unknown;
	toolConnections: unknown;
	triggers: unknown;
	workspaceIds: string[];
	memoryFiles: { path: string; content: string; isEnabled: boolean }[];
	integrationConfigurations: { integrationType: string }[];
	mcpServerConfigurations: { name: string }[];
}

/** Allowlist projection: never serialize a Prisma row or arbitrary settings object. */
export function exportAgentDefinition(
	source: AgentDefinitionSource,
): CurrentAgentDefinition {
	const custom = record(source.customInstructions);
	const policy = record(source.modelConfig ?? source.template.modelConfig);
	const requirements: AgentDefinition["requirements"] = [];
	const retained = requirementsSchema.safeParse(custom.portableRequirements);
	if (retained.success) {
		requirements.push(...retained.data);
	}
	for (const [key, value] of Object.entries(record(source.toolConnections))) {
		if (record(value).enabled === false) {
			continue;
		}
		requirements.push(
			key.startsWith("mcp:")
				? { kind: "mcp", name: "MCP connection" }
				: {
						kind: "tool",
						name: /^[a-z][a-z0-9_-]{0,79}$/.test(key)
							? key
							: "Configured tool",
					},
		);
	}
	for (const binding of source.integrationConfigurations) {
		requirements.push({
			kind: "integration",
			name: binding.integrationType,
		});
	}
	for (const binding of source.mcpServerConfigurations) {
		requirements.push({ kind: "mcp", name: binding.name });
	}
	if (source.workspaceIds.length || custom.knowledgeFilters) {
		requirements.push({ kind: "knowledge", name: "Knowledge access" });
	}
	if (Array.isArray(source.triggers)) {
		for (const trigger of source.triggers) {
			const type = record(trigger).type;
			if (typeof type === "string" && type !== "manual") {
				requirements.push({
					kind: "trigger",
					name: /^[a-z_-]{1,40}$/.test(type)
						? type
						: "Configured trigger",
				});
			}
		}
	}
	const instructions: Record<string, unknown> = {
		template: source.template.instructions,
	};
	for (const key of [
		"role",
		"additionalContext",
		"constraints",
		"starterMessages",
	]) {
		if (custom[key] !== undefined) {
			instructions[key] = custom[key];
		}
	}
	const implementation = agentImplementationSchema.parse(
		custom.portableImplementation ?? { kind: "native" },
	);
	const logicalBindings = logicalBindingsSchema.parse(
		custom.portableBindings ?? [],
	);
	if (
		typeof custom.projectId === "string" &&
		custom.projectId &&
		!logicalBindings.some((binding) => binding.kind === "project")
	) {
		// Preserve association intent, never a source organization's project identity or grant.
		logicalBindings.push({
			name: "associated-project",
			kind: "project",
			required: true,
			operations: [],
		});
	}
	return currentAgentDefinitionSchema.parse({
		apiVersion: "fabric.ai/v2",
		implementation,
		logicalBindings,
		expectedOutput: custom.expectedOutput,
		kind: "Agent",
		name: source.name,
		description: source.description ?? "",
		instructions,
		model: {
			model:
				source.modelOverride ??
				source.template.suggestedModel ??
				undefined,
			temperature: policy.temperature,
			topP: policy.topP,
			maxTokens: policy.maxTokens,
		},
		execution: {
			mode: source.executionMode,
			goal: source.goal ?? undefined,
			maxIterations: source.maxIterations,
			successCriteria: source.successCriteria ?? undefined,
		},
		skills: source.memoryFiles.map((skill) => ({
			path: skill.path,
			content: skill.content,
			enabled: skill.isEnabled,
		})),
		requirements: [
			...new Map(
				requirements.map((item) => [`${item.kind}:${item.name}`, item]),
			).values(),
		].sort(
			(a, b) =>
				a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
		),
	});
}

/** Explicit legacy export is safe only when every v2-only field is absent. */
export function exportLegacyAgentDefinition(
	source: AgentDefinitionSource,
): AgentDefinition {
	const definition = exportAgentDefinition(source);
	if (
		definition.implementation.kind !== "native" ||
		definition.logicalBindings.length ||
		definition.expectedOutput
	) {
		throw new Error(
			"This agent requires fabric.ai/v2. Legacy export would discard implementation or output requirements.",
		);
	}
	const {
		implementation: _implementation,
		logicalBindings: _bindings,
		expectedOutput: _output,
		...legacy
	} = definition;
	return legacyAgentDefinitionSchema.parse({
		...legacy,
		apiVersion: "fabric.ai/v1",
	});
}

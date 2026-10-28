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
const agentDefinitionSchema = z.strictObject({
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
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
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
): AgentDefinition {
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
	return agentDefinitionSchema.parse({
		apiVersion: "fabric.ai/v1",
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

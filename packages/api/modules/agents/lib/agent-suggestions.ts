import type {
	RegisteredAgent,
	RegisteredAgentSuggestion,
	RegisteredAgentSuggestionKind,
	RegisteredAgentSuggestionState,
} from "@repo/database/prisma/generated/client";
import { z } from "zod";

export const SuggestionStateSchema = z.enum([
	"pending",
	"approved",
	"rejected",
	"outdated",
]);

const SuggestionKindSchema = z.enum([
	"instructions",
	"tools",
	"skills",
	"model",
	"knowledge",
	"sub_agent",
	"reliability",
	"discovery",
]);

const InstructionsPayloadSchema = z.object({
	content: z.string(),
	targetBlockId: z.string(),
	type: z.literal("replace"),
});

const ToolsPayloadSchema = z.object({
	action: z.enum(["add", "remove"]),
	toolId: z.string(),
});

const SkillsPayloadSchema = z.object({
	action: z.enum(["add", "remove"]),
	skillId: z.string(),
});

const ModelPayloadSchema = z.object({
	modelId: z.string(),
	reasoningEffort: z.string().optional(),
});

const KnowledgePayloadSchema = z.object({
	action: z.enum(["add", "remove"]),
	method: z.enum(["search", "query_tables"]),
	dataSourceId: z.string(),
	description: z.string().optional(),
});

const SubAgentPayloadSchema = z.object({
	action: z.enum(["add", "remove"]),
	subAgentId: z.string(),
});

const SuggestionPayloadSchema = z
	.union([
		InstructionsPayloadSchema,
		ToolsPayloadSchema,
		SkillsPayloadSchema,
		ModelPayloadSchema,
		KnowledgePayloadSchema,
		SubAgentPayloadSchema,
	])
	.nullable()
	.optional();

export const SuggestionSchema = z.object({
	id: z.string(),
	key: z.string(),
	kind: SuggestionKindSchema,
	title: z.string(),
	description: z.string(),
	payload: SuggestionPayloadSchema,
	state: SuggestionStateSchema,
	conversationId: z.string().nullable().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type AgentSuggestionRecord = z.infer<typeof SuggestionSchema>;

function createSuggestion(
	agentId: string,
	key: string,
	kind: AgentSuggestionRecord["kind"],
	title: string,
	description: string,
): AgentSuggestionRecord {
	const now = new Date().toISOString();

	return {
		id: `${agentId}:${key}`,
		key,
		kind,
		title,
		description,
		payload: null,
		state: "pending",
		conversationId: null,
		createdAt: now,
		updatedAt: now,
	};
}

export function buildDefaultAgentSuggestions(agent: {
	id: string;
	description: string | null;
	status: string;
	deploymentUrl: string | null;
	lastHealthCheck: Date | null;
	conversationCount?: number;
}): AgentSuggestionRecord[] {
	const suggestions: AgentSuggestionRecord[] = [];

	if (!agent.description?.trim()) {
		suggestions.push(
			createSuggestion(
				agent.id,
				"description",
				"instructions",
				"Add a clearer description",
				"Describe the agent's operating boundary, ideal tasks, and any constraints so users can choose it more confidently.",
			),
		);
	}

	if (!agent.deploymentUrl) {
		suggestions.push(
			createSuggestion(
				agent.id,
				"deployment",
				"discovery",
				"Attach a deployment endpoint",
				"Register a deployment URL so health checks and direct access surfaces can verify the agent automatically.",
			),
		);
	}

	if (agent.status !== "ACTIVE") {
		suggestions.push(
			createSuggestion(
				agent.id,
				"status",
				"reliability",
				"Resolve runtime health issues",
				"Investigate the current non-active status and restore the agent before exposing it broadly to users.",
			),
		);
	}

	if (!agent.lastHealthCheck) {
		suggestions.push(
			createSuggestion(
				agent.id,
				"healthcheck",
				"reliability",
				"Run an initial health check",
				"Record a recent health check so operators can tell whether the endpoint is live and reachable.",
			),
		);
	}

	if ((agent.conversationCount ?? 0) === 0) {
		suggestions.push(
			createSuggestion(
				agent.id,
				"adoption",
				"tools",
				"Improve first-run adoption",
				"Add starter prompts, examples, or a narrower purpose statement so users understand when to use this agent.",
			),
		);
	}

	return suggestions;
}

export function mergeAgentSuggestions(params: {
	generated: AgentSuggestionRecord[];
	persisted: RegisteredAgentSuggestion[];
}): AgentSuggestionRecord[] {
	const merged = new Map<string, AgentSuggestionRecord>();

	for (const suggestion of params.generated) {
		merged.set(suggestion.key, suggestion);
	}

	for (const suggestion of params.persisted) {
		merged.set(suggestion.key, fromStoredSuggestion(suggestion));
	}

	return Array.from(merged.values());
}

export function toStoredSuggestionInput(
	suggestion: AgentSuggestionRecord,
	state?: AgentSuggestionRecord["state"],
): {
	key: string;
	kind: RegisteredAgentSuggestionKind;
	title: string;
	description: string;
	state: RegisteredAgentSuggestionState;
	source: string;
} {
	return {
		key: suggestion.key,
		kind: toDbKind(suggestion.kind),
		title: suggestion.title,
		description: suggestion.description,
		state: toDbState(state ?? suggestion.state),
		source: "generated",
	};
}

export { toDbState };

export function fromStoredSuggestion(
	suggestion: RegisteredAgentSuggestion,
): AgentSuggestionRecord {
	return {
		id: suggestion.id,
		key: suggestion.key,
		kind: fromDbKind(suggestion.kind),
		title: suggestion.title,
		description: suggestion.description,
		payload: suggestion.payload as AgentSuggestionRecord["payload"],
		state: fromDbState(suggestion.state),
		conversationId: suggestion.conversationId,
		createdAt: suggestion.createdAt.toISOString(),
		updatedAt: suggestion.updatedAt.toISOString(),
	};
}

export function canReviewAgentSuggestions(params: {
	agent: RegisteredAgent;
	userId: string;
	userRole?: string | null;
	membershipRole?: string | null;
}): boolean {
	const { agent, userId, userRole, membershipRole } = params;

	if (agent.scope === "SYSTEM") {
		return userRole === "admin";
	}

	if (agent.scope === "USER") {
		return agent.userId === userId;
	}

	return membershipRole === "owner" || membershipRole === "admin";
}

function toDbKind(
	kind: AgentSuggestionRecord["kind"],
): RegisteredAgentSuggestionKind {
	switch (kind) {
		case "instructions":
			return "INSTRUCTIONS";
		case "tools":
			return "TOOLS";
		case "skills":
			return "SKILLS";
		case "model":
			return "MODEL";
		case "knowledge":
			return "KNOWLEDGE";
		case "sub_agent":
			return "SUB_AGENT";
		case "reliability":
			return "RELIABILITY";
		case "discovery":
			return "DISCOVERY";
	}
}

function fromDbKind(
	kind: RegisteredAgentSuggestionKind,
): AgentSuggestionRecord["kind"] {
	switch (kind) {
		case "INSTRUCTIONS":
			return "instructions";
		case "TOOLS":
			return "tools";
		case "SKILLS":
			return "skills";
		case "MODEL":
			return "model";
		case "KNOWLEDGE":
			return "knowledge";
		case "SUB_AGENT":
			return "sub_agent";
		case "RELIABILITY":
			return "reliability";
		case "DISCOVERY":
			return "discovery";
	}
}

function toDbState(
	state: AgentSuggestionRecord["state"],
): RegisteredAgentSuggestionState {
	switch (state) {
		case "pending":
			return "PENDING";
		case "approved":
			return "APPROVED";
		case "rejected":
			return "REJECTED";
		case "outdated":
			return "OUTDATED";
	}
}

function fromDbState(
	state: RegisteredAgentSuggestionState,
): AgentSuggestionRecord["state"] {
	switch (state) {
		case "PENDING":
			return "pending";
		case "APPROVED":
			return "approved";
		case "REJECTED":
			return "rejected";
		case "OUTDATED":
			return "outdated";
	}
}

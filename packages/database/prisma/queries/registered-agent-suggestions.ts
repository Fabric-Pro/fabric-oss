import { db } from "../client";
import type {
	Prisma,
	RegisteredAgent,
	RegisteredAgentSuggestion,
	RegisteredAgentSuggestionKind,
	RegisteredAgentSuggestionState,
} from "../generated/client";

function getSuggestionTenantFields(agent: RegisteredAgent) {
	if (agent.scope === "USER") {
		return {
			userId: agent.userId ?? null,
			organizationId: null,
		};
	}

	if (agent.scope === "ORGANIZATION") {
		return {
			userId: null,
			organizationId: agent.organizationId ?? null,
		};
	}

	return {
		userId: null,
		organizationId: null,
	};
}

export async function listRegisteredAgentSuggestions(
	agentId: string,
): Promise<RegisteredAgentSuggestion[]> {
	return db.registeredAgentSuggestion.findMany({
		where: { agentId },
		orderBy: [{ createdAt: "asc" }],
	});
}

export async function listRegisteredAgentSuggestionsByState(
	agentId: string,
	states: RegisteredAgentSuggestionState[],
	limit?: number,
): Promise<RegisteredAgentSuggestion[]> {
	return db.registeredAgentSuggestion.findMany({
		where: { agentId, state: { in: states } },
		orderBy: [{ createdAt: "asc" }],
		...(limit ? { take: limit } : {}),
	});
}

export async function createRegisteredAgentSuggestions(params: {
	agent: RegisteredAgent;
	conversationId?: string;
	suggestions: Array<{
		key: string;
		kind: RegisteredAgentSuggestionKind;
		title: string;
		description: string;
		payload?: Prisma.InputJsonValue;
		source?: string;
	}>;
}): Promise<RegisteredAgentSuggestion[]> {
	const { agent, conversationId, suggestions } = params;
	const tenantFields = getSuggestionTenantFields(agent);

	return db.$transaction(async (tx) => {
		const created: RegisteredAgentSuggestion[] = [];

		for (const suggestion of suggestions) {
			const createData = {
				agentId: agent.id,
				key: suggestion.key,
				userId: tenantFields.userId,
				organizationId: tenantFields.organizationId,
				kind: suggestion.kind,
				title: suggestion.title,
				description: suggestion.description,
				payload: suggestion.payload ?? undefined,
				state: "PENDING" as const,
				source: suggestion.source ?? "sidekick",
				conversationId: conversationId ?? null,
			};

			// Use upsert to handle iterative edits: when the LLM suggests
			// the same block/tool again, we replace the prior row instead
			// of hitting the unique constraint on (agentId, key).
			const row = await tx.registeredAgentSuggestion.upsert({
				where: {
					agentId_key: {
						agentId: agent.id,
						key: suggestion.key,
					},
				},
				create: createData,
				update: {
					kind: suggestion.kind,
					title: suggestion.title,
					description: suggestion.description,
					payload: suggestion.payload ?? undefined,
					state: "PENDING",
					source: suggestion.source ?? "sidekick",
					conversationId: conversationId ?? null,
				},
			});
			created.push(row);
		}

		return created;
	});
}

export async function markRegisteredAgentSuggestionsOutdated(
	agentId: string,
	filter: {
		kind?: RegisteredAgentSuggestionKind;
		keys?: string[];
	},
): Promise<number> {
	const where: Prisma.RegisteredAgentSuggestionWhereInput = {
		agentId,
		state: "PENDING",
		...(filter.kind ? { kind: filter.kind } : {}),
		...(filter.keys ? { key: { in: filter.keys } } : {}),
	};

	const result = await db.registeredAgentSuggestion.updateMany({
		where,
		data: { state: "OUTDATED" },
	});

	return result.count;
}

export async function patchRegisteredAgentSuggestion(
	id: string,
	agentId: string,
	state: RegisteredAgentSuggestionState,
): Promise<RegisteredAgentSuggestion> {
	// Verify the suggestion belongs to the authorized agent before
	// updating, so a user can't patch another agent's suggestion
	// by knowing its ID.
	const existing = await db.registeredAgentSuggestion.findFirst({
		where: { id, agentId },
	});
	if (!existing) {
		throw new Error("Suggestion not found for this agent");
	}
	return db.registeredAgentSuggestion.update({
		where: { id },
		data: { state },
	});
}

export async function countPendingSuggestionsByKind(
	agentId: string,
	kind: RegisteredAgentSuggestionKind,
): Promise<number> {
	return db.registeredAgentSuggestion.count({
		where: { agentId, kind, state: "PENDING" },
	});
}

export async function upsertRegisteredAgentSuggestions(params: {
	agent: RegisteredAgent;
	suggestions: Array<{
		key: string;
		kind: RegisteredAgentSuggestionKind;
		title: string;
		description: string;
		state: RegisteredAgentSuggestionState;
		source?: string;
	}>;
}): Promise<RegisteredAgentSuggestion[]> {
	const { agent, suggestions } = params;
	const tenantFields = getSuggestionTenantFields(agent);

	if (agent.scope === "SYSTEM") {
		return [];
	}

	return db.$transaction(async (tx) => {
		for (const suggestion of suggestions) {
			const createData: Prisma.RegisteredAgentSuggestionUncheckedCreateInput =
				{
					agentId: agent.id,
					key: suggestion.key,
					userId: tenantFields.userId,
					organizationId: tenantFields.organizationId,
					kind: suggestion.kind,
					title: suggestion.title,
					description: suggestion.description,
					state: suggestion.state,
					source: suggestion.source ?? "generated",
				};

			await tx.registeredAgentSuggestion.upsert({
				where: {
					agentId_key: {
						agentId: agent.id,
						key: suggestion.key,
					},
				},
				create: createData,
				update: {
					kind: suggestion.kind,
					title: suggestion.title,
					description: suggestion.description,
					state: suggestion.state,
					source: suggestion.source ?? "generated",
				},
			});
		}

		return tx.registeredAgentSuggestion.findMany({
			where: { agentId: agent.id },
			orderBy: [{ createdAt: "asc" }],
		});
	});
}

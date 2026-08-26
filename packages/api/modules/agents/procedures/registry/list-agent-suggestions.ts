import { ORPCError } from "@orpc/server";
import {
	getRegisteredAgentById,
	listRegisteredAgentSuggestionsByState,
	listRegisteredAgentSuggestions as listRegisteredAgentSuggestionsQuery,
	patchRegisteredAgentSuggestion,
	upsertRegisteredAgentSuggestions,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
	resolveOrganizationId,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import {
	buildDefaultAgentSuggestions,
	canReviewAgentSuggestions,
	fromStoredSuggestion,
	mergeAgentSuggestions,
	SuggestionSchema,
	SuggestionStateSchema,
	toDbState,
	toStoredSuggestionInput,
} from "../../lib/agent-suggestions";

async function getAgentAccess(params: {
	agent: Awaited<ReturnType<typeof getRegisteredAgentById>>;
	userId: string;
	userRole?: string | null;
	organizationId?: string;
}) {
	const { agent, userId, userRole, organizationId } = params;

	if (!agent) {
		throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
	}

	if (agent.scope === "SYSTEM") {
		return {
			canReview: canReviewAgentSuggestions({
				agent,
				userId,
				userRole,
			}),
		};
	}

	if (agent.scope === "USER") {
		if (agent.userId !== userId) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this agent",
			});
		}

		return { canReview: true };
	}

	if (!agent.organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "Invalid organization agent configuration",
		});
	}

	const membership = await verifyOrganizationMembership(
		agent.organizationId,
		userId,
	);
	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "You do not have access to this agent",
		});
	}

	if (organizationId && organizationId !== agent.organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "Agent does not belong to the specified organization",
		});
	}

	return {
		canReview: canReviewAgentSuggestions({
			agent,
			userId,
			userRole,
			membershipRole: membership.role,
		}),
	};
}

/**
 * Persisted Sidekick suggestions are a RegisteredAgent-only concept today —
 * the `RegisteredAgentSuggestion` FK points at `RegisteredAgent`. When the
 * frontend asks about an AgentTemplateInstance, short-circuit with an empty
 * list so the UI can render without 404s instead of forcing a schema change.
 */
const EntityTypeSchema = z
	.enum(["registered", "instance"])
	.optional()
	.default("registered");

export const listAgentSuggestions = protectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/registry/:id/suggestions",
		tags: ["Agent Registry"],
		summary: "List agent suggestions",
		description:
			"Returns curation suggestions for a registered agent, combining generated defaults with persisted review state.",
	})
	.input(
		z.object({
			id: z.string(),
			entityType: EntityTypeSchema,
			organizationId: z.string().nullable().optional(),
			states: z
				.array(SuggestionStateSchema)
				.optional()
				.describe(
					"Filter by suggestion state(s). When omitted, returns generated defaults merged with all persisted.",
				),
			limit: z.number().int().positive().optional(),
		}),
	)
	.output(
		z.object({
			canReview: z.boolean(),
			suggestions: z.array(SuggestionSchema),
		}),
	)
	.handler(async ({ input, context }) => {
		if (input.entityType === "instance") {
			return { canReview: false, suggestions: [] };
		}

		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const agent = await getRegisteredAgentById(input.id);
		const access = await getAgentAccess({
			agent,
			userId: context.user.id,
			userRole: context.user.role,
			organizationId: organizationId ?? undefined,
		});

		// When a states filter is provided, return only persisted rows matching those states
		// (skips the generated-defaults merge — used by the Sidekick frontend)
		if (input.states && input.states.length > 0) {
			const dbStates = input.states.map(toDbState);
			// biome-ignore lint/style/noNonNullAssertion: agent is verified non-null by preceding query
			const persisted = await listRegisteredAgentSuggestionsByState(
				agent!.id,
				dbStates,
				input.limit,
			);
			return {
				canReview: access.canReview,
				suggestions: mergeAgentSuggestions({
					generated: [],
					persisted,
				}),
			};
		}

		// biome-ignore lint/style/noNonNullAssertion: agent is verified non-null by preceding query
		const generated = buildDefaultAgentSuggestions(agent!);
		const persisted =
			agent?.scope === "SYSTEM"
				? []
				: // biome-ignore lint/style/noNonNullAssertion: agent is verified non-null by preceding query
					await listRegisteredAgentSuggestionsQuery(agent!.id);

		return {
			canReview: access.canReview,
			suggestions: mergeAgentSuggestions({ generated, persisted }),
		};
	});

export const updateAgentSuggestions = protectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "PATCH",
		path: "/agents/registry/:id/suggestions",
		tags: ["Agent Registry"],
		summary: "Update agent suggestions",
		description:
			"Persists reviewer decisions for registered-agent curation suggestions.",
	})
	.input(
		z.object({
			id: z.string(),
			entityType: EntityTypeSchema,
			organizationId: z.string().nullable().optional(),
			updates: z
				.array(
					z.object({
						id: z.string(),
						state: SuggestionStateSchema,
					}),
				)
				.min(1),
		}),
	)
	.output(
		z.object({
			canReview: z.boolean(),
			suggestions: z.array(SuggestionSchema),
		}),
	)
	.handler(async ({ input, context }) => {
		if (input.entityType === "instance") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Suggestion persistence is not supported for agent instances",
			});
		}

		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const agent = await getRegisteredAgentById(input.id);
		const access = await getAgentAccess({
			agent,
			userId: context.user.id,
			userRole: context.user.role,
			organizationId: organizationId ?? undefined,
		});

		if (!access.canReview) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"You do not have permission to review suggestions for this agent",
			});
		}

		if (agent?.scope === "SYSTEM") {
			throw new ORPCError("FORBIDDEN", {
				message:
					"System agent suggestions are read-only unless managed through admin workflows",
			});
		}

		// biome-ignore lint/style/noNonNullAssertion: agent is verified non-null by preceding query
		const generated = buildDefaultAgentSuggestions(agent!);
		const updatesById = new Map(
			input.updates.map((update) => [update.id, update.state]),
		);
		const nextState = generated
			.filter((suggestion) => updatesById.has(suggestion.id))
			.map((suggestion) =>
				toStoredSuggestionInput(
					suggestion,
					updatesById.get(suggestion.id),
				),
			);

		if (nextState.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "No matching suggestions were found to update",
			});
		}

		const persisted = await upsertRegisteredAgentSuggestions({
			// biome-ignore lint/style/noNonNullAssertion: agent is verified non-null by preceding query
			agent: agent!,
			suggestions: nextState,
		});

		return {
			canReview: access.canReview,
			suggestions: mergeAgentSuggestions({
				generated,
				persisted,
			}),
		};
	});

export const patchAgentSuggestion = protectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "PATCH",
		path: "/agents/registry/:id/suggestions/:suggestionId",
		tags: ["Agent Registry"],
		summary: "Patch a single agent suggestion state",
		description:
			"Updates the state of a single suggestion by ID. Used by the Sidekick UI for accept/reject actions.",
	})
	.input(
		z.object({
			id: z.string(),
			entityType: EntityTypeSchema,
			suggestionId: z.string(),
			organizationId: z.string().nullable().optional(),
			state: SuggestionStateSchema,
		}),
	)
	.output(
		z.object({
			suggestion: SuggestionSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		if (input.entityType === "instance") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Suggestion persistence is not supported for agent instances",
			});
		}

		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const agent = await getRegisteredAgentById(input.id);
		const access = await getAgentAccess({
			agent,
			userId: context.user.id,
			userRole: context.user.role,
			organizationId: organizationId ?? undefined,
		});

		if (!access.canReview) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"You do not have permission to review suggestions for this agent",
			});
		}

		const dbState = toDbState(input.state);
		const updated = await patchRegisteredAgentSuggestion(
			input.suggestionId,
			input.id,
			dbState,
		);

		return {
			suggestion: fromStoredSuggestion(updated),
		};
	});

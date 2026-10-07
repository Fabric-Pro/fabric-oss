import { ORPCError } from "@orpc/server";
import {
	ConversationNotFoundError,
	DuplicateTurnMessageIdError,
	saveConversationTurn,
	TurnMessageIdConflictError,
	updateConversationSettings,
} from "@repo/database";
import { z } from "zod";
import { INPUT_BOUNDS, idArray } from "../../../../lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { MessageSchema, maybeStripReasoning } from "./update-conversation";

/**
 * Settings the Advisor keeps in a conversation's metadata. `selectedMcpConfigIds`:
 * absent keeps the stored selection, `null` removes it, an array replaces it.
 */
const SettingsSchema = z.object({
	executionMode: z.enum(["lite", "balanced", "deep", "planner"]).optional(),
	instanceId: z.string().min(1).max(INPUT_BOUNDS.name).optional(),
	selectedMcpConfigIds: idArray().nullable().optional(),
	documentChatId: z.string().min(1).max(INPUT_BOUNDS.name).optional(),
});

/**
 * One execution record as the Advisor stores it in `metadata.executions`.
 * Only `id` is interpreted here (it is the turn's execution id); the rest is
 * the client's record, stored as sent, as `update` stored it before.
 */
const ExecutionRecordSchema = z
	.object({ id: z.string().min(1).max(INPUT_BOUNDS.name) })
	.catchall(z.unknown());

/** A turn is the question, any answered clarifications, and the reply. */
const MAX_TURN_MESSAGES = 200;

/**
 * Refuses a request that resolved no organization. The middleware has already
 * refused it; checked again so the queries below can never run without an
 * organization filter.
 */
function requireOrganizationResolved(
	organizationId: string | undefined,
): string {
	if (typeof organizationId !== "string" || organizationId.length === 0) {
		throw new ORPCError("FORBIDDEN", {
			message: "Saving to a conversation requires an organization",
		});
	}
	return organizationId;
}

/**
 * Maps the save's refusals: a conversation or turn outside the caller's
 * tenant is NOT_FOUND; turn messages that repeat an id are a malformed
 * request (BAD_REQUEST); a message id already used by a message the turn
 * does not own conflicts with the stored conversation (CONFLICT).
 */
function orpcErrorFrom(error: unknown): never {
	if (error instanceof ConversationNotFoundError) {
		throw new ORPCError("NOT_FOUND", {
			message: "Conversation not found",
		});
	}
	if (error instanceof DuplicateTurnMessageIdError) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Each message in a turn needs its own id",
		});
	}
	if (error instanceof TurnMessageIdConflictError) {
		throw new ORPCError("CONFLICT", {
			message:
				"A message id in this turn already belongs to another message in the conversation",
		});
	}
	throw error;
}

/**
 * Save one finished Advisor turn into the caller's conversation (Fizzy #2949).
 *
 * Replaces the client's read-modify-write through `update`, which wrote the
 * whole message list and metadata back and so dropped anything another tab
 * had saved in between. The server adds this turn's messages and execution
 * record to the conversation as it is under a row lock; see
 * `saveConversationTurn` for the exact rules. A retried save adds nothing
 * twice.
 *
 * Authorized in the organization the request names, like `removeMessage`:
 * `requireInputOrgPermission` checks membership of that organization and that
 * the caller's role there grants `AGENT_UPDATE`, and `requireOrganization`
 * refuses a request that resolves no organization. A conversation, or an
 * execution id naming a turn, that is not the caller's in that organization
 * is `NOT_FOUND`.
 */
export const saveTurn = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/agents/conversations/{conversationId}/turns",
		tags: ["Agent Conversations"],
		summary: "Save a finished turn to a conversation",
		description:
			"Add one turn's messages and execution record to a conversation, keeping everything else saved in it",
	})
	.input(
		z.object({
			conversationId: z.string(),
			organizationId: z.string().nullable().optional(),
			messages: z.array(MessageSchema).max(MAX_TURN_MESSAGES),
			execution: ExecutionRecordSchema,
			removeMessageIds: idArray(20).optional(),
			settings: SettingsSchema.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationResolved(
			resolveOrganizationId(input.organizationId, context.session),
		);

		try {
			const result = await saveConversationTurn({
				id: input.conversationId,
				userId: context.user.id,
				organizationId,
				messages: input.messages.map(maybeStripReasoning),
				execution: input.execution,
				removeMessageIds: input.removeMessageIds,
				settings: input.settings,
			});
			return { id: input.conversationId, ...result };
		} catch (error) {
			orpcErrorFrom(error);
		}
	});

/**
 * Change an Advisor conversation's settings (chat tools, reasoning mode,
 * agent instance) without rewriting its messages or saved executions
 * (Fizzy #2949). Authorized exactly like `saveTurn`.
 */
export const updateSettings = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "PATCH",
		path: "/agents/conversations/{conversationId}/settings",
		tags: ["Agent Conversations"],
		summary: "Update a conversation's settings",
		description:
			"Change a conversation's chat tools, reasoning mode or agent instance, keeping its messages and executions",
	})
	.input(
		z.object({
			conversationId: z.string(),
			organizationId: z.string().nullable().optional(),
			settings: SettingsSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationResolved(
			resolveOrganizationId(input.organizationId, context.session),
		);

		try {
			await updateConversationSettings({
				id: input.conversationId,
				userId: context.user.id,
				organizationId,
				settings: input.settings,
			});
			return { id: input.conversationId };
		} catch (error) {
			orpcErrorFrom(error);
		}
	});

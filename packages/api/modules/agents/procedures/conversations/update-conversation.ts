import { ORPCError } from "@orpc/server";
import {
	addMessageToConversation,
	updateAgentConversation,
	updateConversationTrajectory,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * Persisted per-message attachment envelope.
 *
 * Captures the minimum metadata we need to re-render an attachment after
 * a page reload: the S3 storage key + the original filename + the MIME
 * type. `previewUrl` is NOT persisted; the read procedures
 * (`getActiveForDocument`, `getByIdForDocument`) sign a fresh short-lived
 * GET URL on every call from `s3Path` so a stored URL never goes stale
 * (signed URLs expire within an hour at most).
 *
 * Size is best-effort metadata (used only by the viewer's UI affordances
 * like the tooltip) — it is optional because the upload pipeline doesn't
 * always have it before persistence.
 *
 * `kind` discriminates the rendering branch in `<ConversationViewer>`:
 *   - `image` → inline <img> preview
 *   - `file`  → Paperclip chip with download link
 * Older rows without `kind` are inferred from `mimeType` on read.
 */
const MessageAttachmentSchema = z.object({
	id: z.string(),
	s3Path: z.string(),
	name: z.string(),
	mimeType: z.string(),
	sizeBytes: z.number().optional(),
	kind: z.enum(["image", "file"]).optional(),
	/**
	 * Filled in by the read procedures with a freshly-signed time-limited
	 * GET URL. Optional on write so the client never has to send it.
	 */
	previewUrl: z.string().optional(),
});

export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

export const MessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "system"]),
	content: z.string(),
	timestamp: z.string(),
	toolCalls: z
		.array(
			z.object({
				id: z.string(),
				name: z.string(),
				args: z.record(z.string(), z.unknown()),
				result: z.string().optional(),
				status: z
					.enum(["pending", "running", "success", "error"])
					.optional(),
			}),
		)
		.optional(),
	agentId: z.string().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	// Stream lifecycle fields persisted alongside the message body so
	// cancelled turns surface the inline `Stopped` caption after a page
	// reload (spec § 5.1 / AC-5). Optional for backwards compat with
	// older persisted messages.
	streamStatus: z
		.enum(["streaming", "completed", "error", "cancelled"])
		.optional(),
	cancelledAt: z.string().optional(),
	// Model reasoning trace fields (extended_thinking / o-series thinking blocks).
	// The schema always accepts these for backward compat with previously-persisted
	// data, but maybeStripReasoning() strips them before DB writes unless the
	// operator has explicitly set FABRIC_PERSIST_REASONING_TRACE=true.
	reasoningText: z.string().optional(),
	reasoningDurationMs: z.number().optional(),
	// Per-message file attachments — see MessageAttachmentSchema docblock.
	attachments: z.array(MessageAttachmentSchema).optional(),
});

/**
 * Strips reasoningText and reasoningDurationMs from an incoming message before
 * writing it to the database, unless the operator has explicitly opted in by
 * setting FABRIC_PERSIST_REASONING_TRACE=true.
 *
 * This is the authoritative server-side trust boundary for the persistence
 * gate. The Zod schema always accepts the fields (for backward compat with
 * previously-persisted data), but the handler always calls this function before
 * any database write. The client in FabricDirectChat.tsx unconditionally sends
 * reasoningText when present; this function is the sole gate.
 *
 * Pure function — does not mutate the input.
 */
export function maybeStripReasoning<
	T extends { reasoningText?: string; reasoningDurationMs?: number },
>(msg: T): T {
	if (process.env.FABRIC_PERSIST_REASONING_TRACE === "true") {
		return msg;
	}
	if (!("reasoningText" in msg) && !("reasoningDurationMs" in msg)) {
		return msg;
	}
	const {
		reasoningText: _rt,
		reasoningDurationMs: _rd,
		...rest
	} = msg as T & {
		reasoningText?: string;
		reasoningDurationMs?: number;
	};
	return rest as T;
}

const TrajectoryNodeSchema = z.object({
	id: z.string(),
	type: z.enum([
		"start",
		"agent",
		"tool_call",
		"tool_result",
		"decision",
		"hitl",
		"end",
	]),
	agentId: z.string().optional(),
	agentName: z.string().optional(),
	label: z.string(),
	status: z.enum(["pending", "running", "success", "error"]),
	timestamp: z.string(),
	duration: z.number().optional(),
	input: z.record(z.string(), z.unknown()).optional(),
	output: z.record(z.string(), z.unknown()).optional(),
	error: z.string().optional(),
	children: z.array(z.string()),
});

const TrajectorySchema = z.object({
	id: z.string(),
	nodes: z.array(TrajectoryNodeSchema),
	edges: z.array(z.object({ source: z.string(), target: z.string() })),
	startTime: z.string(),
	endTime: z.string().optional(),
	status: z.enum(["running", "completed", "failed"]),
});

/**
 * Update an agent conversation
 */
export const updateConversation = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "PATCH",
		path: "/agents/conversations/{id}",
		tags: ["Agent Conversations"],
		summary: "Update an agent conversation",
		description:
			"Update conversation title, messages, trajectory, or status",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().nullish(),
			messages: z.array(MessageSchema).optional(),
			trajectory: TrajectorySchema.nullish(),
			metadata: z.record(z.string(), z.unknown()).optional(),
			pinned: z.boolean().optional(),
			status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		try {
			const conversation = await updateAgentConversation({
				id: input.id,
				userId: user.id,
				organizationId,
				title: input.title,
				messages: input.messages?.map(maybeStripReasoning),
				trajectory: input.trajectory,
				metadata: input.metadata,
				pinned: input.pinned,
				status: input.status,
			});

			return {
				id: conversation.id,
				title: conversation.title,
				pinned: conversation.pinned,
				status: conversation.status,
				updatedAt: conversation.updatedAt.toISOString(),
			};
		} catch (_error) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}
	});

/**
 * Add a single message to a conversation
 */
export const addMessage = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "POST",
		path: "/agents/conversations/{conversationId}/messages",
		tags: ["Agent Conversations"],
		summary: "Add a message to a conversation",
		description: "Append a new message to an existing conversation",
	})
	.input(
		z.object({
			conversationId: z.string(),
			organizationId: z.string().nullable().optional(),
			message: MessageSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		try {
			const conversation = await addMessageToConversation({
				id: input.conversationId,
				userId: user.id,
				organizationId,
				message: maybeStripReasoning(input.message),
			});

			return {
				id: conversation.id,
				messageCount: Array.isArray(conversation.messages)
					? conversation.messages.length
					: 0,
				updatedAt: conversation.updatedAt.toISOString(),
			};
		} catch (_error) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}
	});

/**
 * Update trajectory for a conversation
 */
export const updateTrajectory = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "PUT",
		path: "/agents/conversations/{conversationId}/trajectory",
		tags: ["Agent Conversations"],
		summary: "Update conversation trajectory",
		description: "Update the execution trajectory for a conversation",
	})
	.input(
		z.object({
			conversationId: z.string(),
			organizationId: z.string().nullable().optional(),
			trajectory: TrajectorySchema,
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		try {
			const conversation = await updateConversationTrajectory({
				id: input.conversationId,
				userId: user.id,
				organizationId,
				trajectory: input.trajectory,
			});

			return {
				id: conversation.id,
				updatedAt: conversation.updatedAt.toISOString(),
			};
		} catch (_error) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}
	});

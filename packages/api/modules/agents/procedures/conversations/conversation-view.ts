/**
 * What `agents.conversations.list` and `.get` answer, as schemas the client
 * infers its types from, and the functions that make each answer from a stored
 * row.
 *
 * The stored row is JSON that has been written by several versions of several
 * clients, so the answer is built from what parses and the rest is left out,
 * instead of failing the whole response on one odd message.
 */

import type { AgentConversationForViewer } from "@repo/database";
import { z } from "zod";

const ToolStatusSchema = z.enum(["pending", "running", "success", "error"]);

const JsonRecordSchema = z.record(z.string(), z.unknown());

const ConversationMessageSchema = z.looseObject({
	id: z.string(),
	role: z.enum(["user", "assistant", "system"]),
	content: z.string(),
	timestamp: z.string(),
	toolCalls: z
		.array(
			z.looseObject({
				id: z.string(),
				name: z.string(),
				args: JsonRecordSchema,
				result: z.string().optional(),
				status: ToolStatusSchema.optional(),
			}),
		)
		.optional(),
	agentId: z.string().optional(),
	metadata: JsonRecordSchema.optional(),
	streamStatus: z
		.enum(["streaming", "completed", "error", "cancelled"])
		.optional(),
	cancelledAt: z.string().optional(),
	reasoningText: z.string().optional(),
	reasoningDurationMs: z.number().optional(),
	attachments: z
		.array(
			z.looseObject({
				id: z.string(),
				s3Path: z.string(),
				name: z.string(),
				mimeType: z.string(),
				sizeBytes: z.number().optional(),
				kind: z.enum(["image", "file"]).optional(),
				previewUrl: z.string().optional(),
			}),
		)
		.optional(),
});

const ConversationTrajectorySchema = z.looseObject({
	id: z.string(),
	nodes: z.array(
		z.looseObject({
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
			status: ToolStatusSchema,
			timestamp: z.string(),
			duration: z.number().optional(),
			input: JsonRecordSchema.optional(),
			output: JsonRecordSchema.optional(),
			error: z.string().optional(),
			children: z.array(z.string()),
		}),
	),
	edges: z.array(z.object({ source: z.string(), target: z.string() })),
	startTime: z.string(),
	endTime: z.string().optional(),
	status: z.enum(["running", "completed", "failed"]),
});

const ConversationOwnerSchema = z.object({
	id: z.string(),
	name: z.string(),
});

const ConversationFieldsSchema = z.object({
	id: z.string(),
	agentId: z.string(),
	title: z.string().nullable(),
	pinned: z.boolean(),
	status: z.enum(["ACTIVE", "ARCHIVED"]),
	visibility: z.enum(["PRIVATE", "ORGANIZATION"]),
	createdAt: z.string(),
	updatedAt: z.string(),
	metadata: JsonRecordSchema.nullable(),
	isOwn: z.boolean(),
	owner: ConversationOwnerSchema,
});

const ConversationListItemSchema = ConversationFieldsSchema.extend({
	messageCount: z.number(),
	lastMessage: z.string().nullable(),
});

export const ConversationListOutputSchema = z.object({
	conversations: z.array(ConversationListItemSchema),
	hasMore: z.boolean(),
	/** How many sessions the list is over, as the route always said. */
	total: z.number(),
	nextCursor: z.string().optional(),
});

export const ConversationDetailSchema = ConversationFieldsSchema.extend({
	messages: z.array(ConversationMessageSchema),
	trajectory: ConversationTrajectorySchema.nullable(),
	parentConversationId: z.string().nullable(),
	carriedOverSummary: z.string().nullable(),
	carriedOverAt: z.string().nullable(),
});

function recordOrNull(value: unknown): Record<string, unknown> | null {
	const parsed = JsonRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/**
 * What a reader who is not the owner is told of a session's metadata: which
 * engine it ran on, which the history list shows as a badge, and nothing else.
 * The rest of it is the owner's own settings, their chosen connections and the
 * record of each turn's execution.
 */
function readerMetadata(stored: unknown): Record<string, unknown> | null {
	const metadata = recordOrNull(stored);
	return typeof metadata?.mode === "string" ? { mode: metadata.mode } : null;
}

function messagesOf(stored: unknown) {
	if (!Array.isArray(stored)) {
		return [];
	}
	return stored.flatMap((message) => {
		const parsed = ConversationMessageSchema.safeParse(message);
		return parsed.success ? [parsed.data] : [];
	});
}

function lastMessagePreview(messages: ReturnType<typeof messagesOf>) {
	const last = messages.at(-1);
	return last ? last.content.slice(0, 100) : null;
}

function fieldsOf(conversation: AgentConversationForViewer) {
	return {
		id: conversation.id,
		agentId: conversation.agentId,
		title: conversation.title,
		// A pin belongs to the owner's own list; it means nothing in someone else's.
		pinned: conversation.isOwn && conversation.pinned,
		status: conversation.status,
		visibility: conversation.visibility,
		createdAt: conversation.createdAt.toISOString(),
		updatedAt: conversation.updatedAt.toISOString(),
		metadata: conversation.isOwn
			? recordOrNull(conversation.metadata)
			: readerMetadata(conversation.metadata),
		isOwn: conversation.isOwn,
		owner: conversation.owner,
	};
}

/** A conversation as a history list shows it: no messages, a count and a preview of the last. */
export function listItemOf(
	conversation: AgentConversationForViewer,
): z.infer<typeof ConversationListItemSchema> {
	const messages = messagesOf(conversation.messages);
	return {
		...fieldsOf(conversation),
		messageCount: Array.isArray(conversation.messages)
			? conversation.messages.length
			: 0,
		lastMessage: lastMessagePreview(messages),
	};
}

/**
 * A conversation opened. Its owner gets everything that parses of its messages
 * and trajectory. Anyone else, who can read it because the owner shared it, gets
 * the transcript and nothing behind it: each message's role, text and time, with
 * no tool calls or what they returned, no reasoning, no attachments (whose
 * storage paths are the owner's), no trajectory, no execution record, and none
 * of what the owner carried over from an earlier chat of theirs.
 */
export function detailOf(
	conversation: AgentConversationForViewer,
): z.infer<typeof ConversationDetailSchema> {
	if (!conversation.isOwn) {
		return {
			...fieldsOf(conversation),
			messages: messagesOf(conversation.messages).map(
				({ id, role, content, timestamp }) => ({
					id,
					role,
					content,
					timestamp,
				}),
			),
			trajectory: null,
			parentConversationId: null,
			carriedOverSummary: null,
			carriedOverAt: null,
		};
	}
	const trajectory = ConversationTrajectorySchema.safeParse(
		conversation.trajectory,
	);
	return {
		...fieldsOf(conversation),
		messages: messagesOf(conversation.messages),
		trajectory: trajectory.success ? trajectory.data : null,
		parentConversationId: conversation.parentConversationId,
		carriedOverSummary: conversation.carriedOverSummary,
		carriedOverAt: conversation.carriedOverAt?.toISOString() ?? null,
	};
}

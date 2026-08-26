/**
 * Agent Template Conversation Queries
 *
 * Handles conversation history for multi-turn agent executions.
 * Conversations are optional - single-turn executions don't need them.
 *
 * TENANT ISOLATION:
 * - Personal context: Only loads conversations where organizationId IS NULL
 * - Org context: Only loads conversations for that specific org
 *
 * NOTE: Types are prefixed with "Template" to avoid conflicts with
 * agent-conversations.ts which handles orchestrator conversations.
 */

import { db, type Prisma } from "../../client";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Message in a template conversation
 * Prefixed to avoid conflict with agent-conversations.ts ConversationMessage
 */
export interface TemplateConversationMessage {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: string;
	metadata?: Record<string, unknown>;
}

export interface TemplateConversationContext {
	knowledgeResults?: Array<{
		source: string;
		content: string;
		similarity: number;
	}>;
	toolResults?: Array<{
		name: string;
		result: unknown;
	}>;
}

export interface CreateTemplateConversationInput {
	instanceId: string;
	userId: string;
	organizationId?: string;
	title?: string;
	initialMessage?: TemplateConversationMessage;
}

export interface AppendTemplateMessageInput {
	conversationId: string;
	userId: string;
	organizationId?: string;
	message: TemplateConversationMessage;
	context?: TemplateConversationContext;
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

// =============================================================================
// CREATE
// =============================================================================

/**
 * Create a new conversation for an agent template instance
 */
export async function createTemplateConversation(
	input: CreateTemplateConversationInput,
) {
	const { instanceId, userId, organizationId, title, initialMessage } = input;

	const messages: TemplateConversationMessage[] = initialMessage
		? [initialMessage]
		: [];

	return await db.agentTemplateConversation.create({
		data: {
			instanceId,
			userId,
			organizationId,
			title: title || `Conversation ${new Date().toLocaleDateString()}`,
			messages: messages as unknown as Prisma.InputJsonValue,
		},
	});
}

// =============================================================================
// READ
// =============================================================================

export interface GetTemplateConversationOptions {
	userId: string;
	organizationId?: string;
}

/**
 * Get a template conversation by ID with strict tenant isolation
 */
export async function getTemplateConversation(
	conversationId: string,
	options: GetTemplateConversationOptions,
) {
	const { userId, organizationId } = options;

	// Strict isolation: org context XOR personal
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.agentTemplateConversation.findFirst({
		where: {
			id: conversationId,
			userId,
			...orgFilter,
		},
	});
}

/**
 * Get template conversation messages as typed array
 */
export async function getTemplateConversationMessages(
	conversationId: string,
	options: GetTemplateConversationOptions,
): Promise<TemplateConversationMessage[]> {
	const conversation = await getTemplateConversation(conversationId, options);

	if (!conversation) {
		return [];
	}

	return (
		(conversation.messages as unknown as TemplateConversationMessage[]) ||
		[]
	);
}

export interface ListTemplateConversationsOptions {
	instanceId: string;
	userId: string;
	organizationId?: string;
	includeArchived?: boolean;
	limit?: number;
	offset?: number;
}

/**
 * List conversations for an agent template instance
 */
export async function listTemplateConversations(
	options: ListTemplateConversationsOptions,
) {
	const {
		instanceId,
		userId,
		organizationId,
		includeArchived = false,
		limit = 20,
		offset = 0,
	} = options;

	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.AgentTemplateConversationWhereInput = {
		instanceId,
		userId,
		...orgFilter,
		...(includeArchived ? {} : { isArchived: false }),
	};

	const [conversations, total] = await Promise.all([
		db.agentTemplateConversation.findMany({
			where,
			orderBy: { updatedAt: "desc" },
			take: limit,
			skip: offset,
		}),
		db.agentTemplateConversation.count({ where }),
	]);

	return { conversations, total };
}

// =============================================================================
// UPDATE
// =============================================================================

/**
 * Append a message to a template conversation
 */
export async function appendTemplateMessage(input: AppendTemplateMessageInput) {
	const {
		conversationId,
		userId,
		organizationId,
		message,
		context,
		tokenUsage,
	} = input;

	// First get the conversation with tenant isolation
	const conversation = await getTemplateConversation(conversationId, {
		userId,
		organizationId,
	});

	if (!conversation) {
		throw new Error("Conversation not found or access denied");
	}

	const existingMessages =
		(conversation.messages as unknown as TemplateConversationMessage[]) ||
		[];
	const newMessages = [...existingMessages, message];

	// Merge context if provided
	let newContext = conversation.context as TemplateConversationContext | null;
	if (context) {
		newContext = {
			...newContext,
			...context,
		};
	}

	return await db.agentTemplateConversation.update({
		where: { id: conversationId },
		data: {
			messages: newMessages as unknown as Prisma.InputJsonValue,
			context: newContext as unknown as Prisma.InputJsonValue,
			inputTokens: tokenUsage
				? { increment: tokenUsage.inputTokens }
				: undefined,
			outputTokens: tokenUsage
				? { increment: tokenUsage.outputTokens }
				: undefined,
		},
	});
}

/**
 * Update template conversation metadata
 */
export async function updateTemplateConversation(
	conversationId: string,
	userId: string,
	organizationId: string | undefined,
	data: {
		title?: string;
		isPinned?: boolean;
		isArchived?: boolean;
	},
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.agentTemplateConversation.updateMany({
		where: {
			id: conversationId,
			userId,
			...orgFilter,
		},
		data,
	});
}

// =============================================================================
// DELETE
// =============================================================================

/**
 * Delete a template conversation
 */
export async function deleteTemplateConversation(
	conversationId: string,
	userId: string,
	organizationId?: string,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.agentTemplateConversation.deleteMany({
		where: {
			id: conversationId,
			userId,
			...orgFilter,
		},
	});
}

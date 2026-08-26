/**
 * Database queries for Project-Conversation Attachments
 *
 * Handles attaching projects to orchestrator conversations.
 * Enforces one-project-per-conversation via @@unique([conversationId]).
 * Tenant isolation is achieved through join-through verification
 * (checking parent table ownership), not direct tenant columns.
 */

import { db } from "../../client";

// ============================================================================
// Attach / Detach
// ============================================================================

/**
 * Attach a project to a conversation. Replaces any existing project attachment
 * due to @@unique([conversationId]) constraint — one project per conversation.
 */
export async function attachProjectToConversation(input: {
	projectId: string;
	conversationId: string;
	userId: string;
}) {
	const { projectId, conversationId, userId } = input;

	// Verify the conversation belongs to this user
	const conversation = await db.agentConversation.findFirst({
		where: { id: conversationId, userId },
		select: { id: true },
	});

	if (!conversation) {
		throw new Error("Conversation not found or access denied");
	}

	// Upsert: replace any existing project attachment for this conversation
	return db.projectConversation.upsert({
		where: { conversationId },
		create: {
			projectId,
			conversationId,
			attachedBy: userId,
		},
		update: {
			projectId,
			attachedBy: userId,
			attachedAt: new Date(),
		},
		include: {
			project: {
				select: {
					id: true,
					name: true,
					description: true,
					goals: true,
					techStack: true,
					features: true,
					status: true,
					repositoryUrl: true,
					codeAnalysisStatus: true,
				},
			},
		},
	});
}

/**
 * Detach the project from a conversation. No-op if none attached.
 */
export async function detachProjectFromConversation(input: {
	conversationId: string;
	userId: string;
}) {
	const { conversationId, userId } = input;

	// Verify the conversation belongs to this user
	const conversation = await db.agentConversation.findFirst({
		where: { id: conversationId, userId },
		select: { id: true },
	});

	if (!conversation) {
		throw new Error("Conversation not found or access denied");
	}

	// Delete the attachment if it exists
	return db.projectConversation.deleteMany({
		where: { conversationId },
	});
}

/**
 * Get the project attached to a conversation, or null if none.
 */
export async function getConversationProject(conversationId: string) {
	const attachment = await db.projectConversation.findUnique({
		where: { conversationId },
		include: {
			project: {
				select: {
					id: true,
					name: true,
					description: true,
					goals: true,
					techStack: true,
					features: true,
					status: true,
					repositoryUrl: true,
					codeAnalysisStatus: true,
					_count: {
						select: {
							contexts: {
								where: { importedDocuments: { none: {} } },
							},
							documents: true,
						},
					},
				},
			},
		},
	});

	if (!attachment) {
		return null;
	}

	return {
		...attachment,
		project: {
			...attachment.project,
			contextCount: attachment.project._count.contexts,
			documentCount: attachment.project._count.documents,
		},
	};
}

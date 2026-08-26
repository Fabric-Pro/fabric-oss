/**
 * `agents.conversations.appendTurnForDocument`.
 *
 * Stream-completion-only persistence (FR-2). Order is strict:
 *   1. Feature-flag gate
 *   2. 50/day soft cap when conversationId is omitted → lazy-create
 *   3. Ownership check when conversationId is provided
 *   4. Reasoning-trace strip via maybeStripReasoning
 *   5. 64 KB per-message truncation (preserves toolCalls intact)
 *   6. 200-turn cap → spill to a continuation (parentConversationId)
 *   7. Append via addMessageToConversation
 *   8. First-user-message sets visibilityLockedAt
 *   9. Idempotency: duplicate message.id returns without re-appending
 */

import { ORPCError } from "@orpc/server";
import {
	countDocumentAssistantConversationsInLast24h,
	createDocumentAssistantConversation,
	db,
	getActiveDocumentAssistantConversation,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import {
	DocumentAssistantVisibilitySchema,
	DocumentRefSchema,
	HISTORY_DISABLED_MESSAGE,
	MAX_CONVERSATION_TURNS,
	MessageSchema,
	maybeStripReasoning,
	NEW_CONVERSATIONS_PER_DAY_CAP,
	NEW_CONVERSATIONS_PER_DAY_MESSAGE,
	truncateMessageBodyIfNeeded,
} from "./_shared";

interface StoredMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: string;
	toolCalls?: unknown[];
	[key: string]: unknown;
}

/**
 * Convert the Zod-validated message into the JSON shape the DB stores. We
 * drop `undefined` fields so the persisted row stays compact; everything
 * else is passed through unchanged.
 */
function toStoredMessage(
	message: z.infer<typeof MessageSchema>,
): StoredMessage {
	const stored: StoredMessage = {
		id: message.id,
		role: message.role,
		content: message.content,
		timestamp: message.timestamp,
	};
	if (message.toolCalls !== undefined) {
		stored.toolCalls = message.toolCalls;
	}
	if (message.agentId !== undefined) {
		stored.agentId = message.agentId;
	}
	if (message.metadata !== undefined) {
		stored.metadata = message.metadata;
	}
	if (message.streamStatus !== undefined) {
		stored.streamStatus = message.streamStatus;
	}
	if (message.cancelledAt !== undefined) {
		stored.cancelledAt = message.cancelledAt;
	}
	if (message.reasoningText !== undefined) {
		stored.reasoningText = message.reasoningText;
	}
	if (message.reasoningDurationMs !== undefined) {
		stored.reasoningDurationMs = message.reasoningDurationMs;
	}
	// Per-message attachments — see `MessageAttachmentSchema` docblock for
	// the design. We store the durable subset (s3Path, name, mimeType,
	// sizeBytes, kind, id) and explicitly DROP `previewUrl` because that
	// field is signed fresh on every read. Persisting a signed URL would
	// guarantee broken images within an hour.
	if (Array.isArray(message.attachments) && message.attachments.length > 0) {
		stored.attachments = message.attachments.map((att) => ({
			id: att.id,
			s3Path: att.s3Path,
			name: att.name,
			mimeType: att.mimeType,
			...(att.sizeBytes !== undefined
				? { sizeBytes: att.sizeBytes }
				: {}),
			...(att.kind !== undefined ? { kind: att.kind } : {}),
		}));
	}
	return stored;
}

function conversationHasUserMessage(messages: unknown): boolean {
	if (!Array.isArray(messages)) {
		return false;
	}
	return messages.some(
		(m) =>
			m &&
			typeof m === "object" &&
			(m as { role?: unknown }).role === "user",
	);
}

function conversationHasMessageId(messages: unknown, id: string): boolean {
	if (!Array.isArray(messages)) {
		return false;
	}
	return messages.some(
		(m) => m && typeof m === "object" && (m as { id?: unknown }).id === id,
	);
}

export const appendTurnForDocument = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/agents/conversations/document-assistant/append-turn",
		tags: ["Agent Conversations", "Document Assistant"],
		summary: "Append a completed assistant turn",
		description:
			"Persist one CopilotKit turn (user, assistant, tool-call result, cancellation, or error). Stream-completion only — never called on streaming deltas. Lazy-creates the conversation on first call.",
	})
	.input(
		DocumentRefSchema.extend({
			conversationId: z.string().optional(),
			message: MessageSchema,
			agentId: z.string().min(1),
			requestedVisibility: DocumentAssistantVisibilitySchema.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// ------------------------------------------------------------------
		// 1. Feature-flag gate (org context only)
		// ------------------------------------------------------------------
		if (organizationId) {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { documentAssistantHistoryEnabled: true },
			});
			if (org?.documentAssistantHistoryEnabled === false) {
				throw new ORPCError("CONFLICT", {
					message: HISTORY_DISABLED_MESSAGE,
				});
			}
		}

		const tenantFilter: Parameters<
			typeof createDocumentAssistantConversation
		>[0]["tenantFilter"] = organizationId
			? { organizationId, userId: user.id }
			: { organizationId: null, userId: user.id };
		const strippedMessage = maybeStripReasoning(input.message);
		const truncatedMessage = truncateMessageBodyIfNeeded(strippedMessage);
		const storedMessage = toStoredMessage(truncatedMessage);

		let targetJoinId: string;
		let targetConversationId: string;
		let createdNewConversation = false;
		let createdJoinId: string | null = null;

		// ------------------------------------------------------------------
		// 2. Lazy-create when conversationId omitted
		// ------------------------------------------------------------------
		if (!input.conversationId) {
			// Concurrency: if a sibling tab (or a faster racing request)
			// already lazy-created an active conversation for this
			// (user, document) pair, reuse it instead of creating a
			// duplicate. Without this check, two tabs first-loading the
			// same document and both sending an opening turn would each
			// create their own conversation → the History drawer would
			// list two single-turn rows that the user can't reconcile.
			//
			// The check is best-effort: there is still a sub-millisecond
			// window where two parallel requests both findFirst → both
			// miss → both create. We accept that residual race because
			// (a) it requires nanosecond-aligned typing in two tabs,
			// (b) no data is lost, (c) the History drawer surfaces both
			// rows so the user can pick one and archive the other, and
			// (d) closing the window completely requires a partial
			// unique index migration we'll land separately. The long-term
			// intent is "one active conversation per (document, author)"
			// (FR-22).
			const existingActive = await getActiveDocumentAssistantConversation(
				{
					tenantFilter,
					documentRefKind: input.documentRefKind,
					documentRefId: input.documentRefId,
				},
			);
			if (existingActive) {
				targetJoinId = existingActive.id;
				targetConversationId = existingActive.conversationId;
			} else {
				const count =
					await countDocumentAssistantConversationsInLast24h({
						userId: user.id,
						documentRefKind: input.documentRefKind,
						documentRefId: input.documentRefId,
					});
				if (count >= NEW_CONVERSATIONS_PER_DAY_CAP) {
					throw new ORPCError("CONFLICT", {
						message: NEW_CONVERSATIONS_PER_DAY_MESSAGE,
					});
				}

				const created = await createDocumentAssistantConversation({
					tenantFilter,
					documentRefKind: input.documentRefKind,
					documentRefId: input.documentRefId,
					projectId: input.projectId,
					agentId: input.agentId,
					visibility: input.requestedVisibility ?? "SHARED",
				});
				targetJoinId = created.join.id;
				targetConversationId = created.conversation.id;
				createdNewConversation = true;
				createdJoinId = created.join.id;
			}
		} else {
			// --------------------------------------------------------------
			// 3. Ownership check
			// --------------------------------------------------------------
			const existing = await db.documentAssistantConversation.findUnique({
				where: { conversationId: input.conversationId },
				select: { id: true, userId: true, organizationId: true },
			});
			if (
				!existing ||
				existing.userId !== user.id ||
				(existing.organizationId ?? null) !== (organizationId ?? null)
			) {
				// NOT_FOUND for cross-tenant (avoids info leak), FORBIDDEN when
				// the row exists for someone else in the same tenant.
				if (
					!existing ||
					(existing.organizationId ?? null) !==
						(organizationId ?? null)
				) {
					throw new ORPCError("NOT_FOUND", {
						message: "Conversation not found",
					});
				}
				throw new ORPCError("FORBIDDEN", {
					message: "You are not the author of this conversation",
				});
			}
			targetJoinId = existing.id;
			targetConversationId = input.conversationId;
		}

		// ------------------------------------------------------------------
		// 4–8. Append (with spill + lock + idempotency)
		// ------------------------------------------------------------------
		const result = await db.$transaction(async (tx) => {
			const conversation = await tx.agentConversation.findFirst({
				where: {
					id: targetConversationId,
					userId: user.id,
					organizationId: organizationId ?? null,
				},
				select: {
					id: true,
					messages: true,
					agentId: true,
				},
			});
			if (!conversation) {
				throw new ORPCError("NOT_FOUND", {
					message: "Conversation not found",
				});
			}

			// 9. Idempotency with late-arriving toolCalls merge.
			//
			// CopilotKit 1.52's free hook tree streams the assistant turn as
			// TWO live messages: the text first, the tool-calls a moment
			// later. The persistence walker fires when the text settles, so
			// the first appendTurn call has `toolCalls: []`. When the
			// tool-call sibling arrives, the walker re-fires and calls
			// appendTurn again with the SAME message id but populated
			// `toolCalls`. Pre-fix this was a no-op (duplicate id → return
			// existing), which silently dropped the tool-call data and
			// broke the Accepted / Rejected / View-version chip flow on
			// production.
			//
			// New behavior on duplicate id:
			//   - If the new payload has toolCalls AND the existing message
			//     has none, MERGE them onto the existing row.
			//   - If the existing message ALREADY has toolCalls, leave it
			//     alone. This keeps a later "no toolCalls" call from
			//     blanking a prior populated state, and prevents append
			//     re-runs (page reload → SSR hydration → persistence walker
			//     re-fires for old turns) from churning the row.
			//   - For any other field, the duplicate path stays a no-op —
			//     content/role/status are frozen at first write.
			if (
				conversationHasMessageId(
					conversation.messages,
					storedMessage.id,
				)
			) {
				const incomingToolCalls = (
					storedMessage as { toolCalls?: unknown }
				).toolCalls;
				const hasIncomingToolCalls =
					Array.isArray(incomingToolCalls) &&
					incomingToolCalls.length > 0;
				let updatedAtIso: string;
				if (hasIncomingToolCalls) {
					const currentMessages = Array.isArray(conversation.messages)
						? (conversation.messages as unknown[])
						: [];
					let didMerge = false;
					const merged = currentMessages.map((raw) => {
						if (!raw || typeof raw !== "object") {
							return raw;
						}
						const m = raw as {
							id?: unknown;
							toolCalls?: unknown[];
						};
						if (m.id !== storedMessage.id) {
							return raw;
						}
						const existing = Array.isArray(m.toolCalls)
							? m.toolCalls
							: [];
						// Only merge if the existing row has no toolCalls.
						// This is the "fill in missing" semantics — we do
						// NOT overwrite if the row already has stamps.
						if (existing.length > 0) {
							return raw;
						}
						didMerge = true;
						return { ...m, toolCalls: incomingToolCalls };
					});
					if (didMerge) {
						const updatedConversation =
							await tx.agentConversation.update({
								where: { id: targetConversationId },
								data: { messages: merged as never },
								select: { updatedAt: true },
							});
						await tx.documentAssistantConversation.update({
							where: { id: targetJoinId },
							data: {
								updatedAt: updatedConversation.updatedAt,
							},
						});
						updatedAtIso =
							updatedConversation.updatedAt.toISOString();
					} else {
						const join =
							await tx.documentAssistantConversation.findUnique({
								where: { id: targetJoinId },
								select: { updatedAt: true },
							});
						updatedAtIso =
							join?.updatedAt.toISOString() ??
							new Date().toISOString();
					}
				} else {
					const join =
						await tx.documentAssistantConversation.findUnique({
							where: { id: targetJoinId },
							select: { updatedAt: true },
						});
					updatedAtIso =
						join?.updatedAt.toISOString() ??
						new Date().toISOString();
				}
				return {
					conversationId: targetConversationId,
					persistedAt: updatedAtIso,
					spilledTo: undefined as string | undefined,
				};
			}

			const currentMessages = Array.isArray(conversation.messages)
				? (conversation.messages as unknown[])
				: [];

			// 6. Spill when adding would exceed the per-conversation cap. Create
			//    a continuation `AgentConversation` with parentConversationId
			//    set + a sibling join row mirroring the same documentRef/
			//    visibility/lock so the History drawer can stitch the chain.
			if (currentMessages.length >= MAX_CONVERSATION_TURNS) {
				const parentJoin =
					await tx.documentAssistantConversation.findUnique({
						where: { id: targetJoinId },
						select: {
							projectId: true,
							organizationId: true,
							userId: true,
							documentRefKind: true,
							documentRefId: true,
							visibility: true,
							visibilityLockedAt: true,
						},
					});
				if (!parentJoin) {
					throw new ORPCError("NOT_FOUND", {
						message: "Conversation not found",
					});
				}
				const continuation = await tx.agentConversation.create({
					data: {
						userId: parentJoin.userId,
						organizationId: parentJoin.organizationId,
						agentId: conversation.agentId,
						messages: [storedMessage] as unknown as never,
						parentConversationId: targetConversationId,
					},
				});
				const continuationJoin =
					await tx.documentAssistantConversation.create({
						data: {
							conversationId: continuation.id,
							projectId: parentJoin.projectId,
							organizationId: parentJoin.organizationId,
							userId: parentJoin.userId,
							documentRefKind: parentJoin.documentRefKind,
							documentRefId: parentJoin.documentRefId,
							visibility: parentJoin.visibility,
							// Inherit the lock — a spill never gives the author a
							// second visibility-toggle window.
							visibilityLockedAt: parentJoin.visibilityLockedAt,
						},
					});
				return {
					conversationId: continuation.id,
					persistedAt: continuationJoin.updatedAt.toISOString(),
					spilledTo: continuation.id,
					spilledFromJoinId: targetJoinId,
					spilledFromConversationId: targetConversationId,
					spilledToJoinId: continuationJoin.id,
				};
			}

			const updatedMessages = [...currentMessages, storedMessage];
			const updatedConversation = await tx.agentConversation.update({
				where: { id: targetConversationId },
				data: {
					messages: updatedMessages as never,
				},
				select: { updatedAt: true },
			});

			// 8. Lock visibility when the first user-role message lands. The
			//    `updateMany` with `visibilityLockedAt: null` is a guard-rail
			//    against a racing setVisibility call slipping in between the
			//    cap-check and the lock — Postgres serialises the row update.
			const shouldLock =
				storedMessage.role === "user" &&
				!conversationHasUserMessage(currentMessages);
			if (shouldLock) {
				await tx.documentAssistantConversation.updateMany({
					where: { id: targetJoinId, visibilityLockedAt: null },
					data: { visibilityLockedAt: new Date() },
				});
			}

			// Bump the join's updatedAt so the History drawer's sort by
			// `updatedAt DESC` reflects this turn's arrival.
			await tx.documentAssistantConversation.update({
				where: { id: targetJoinId },
				data: { updatedAt: updatedConversation.updatedAt },
			});

			return {
				conversationId: targetConversationId,
				persistedAt: updatedConversation.updatedAt.toISOString(),
				spilledTo: undefined as string | undefined,
			};
		});

		// ------------------------------------------------------------------
		// Audit emissions — outside the transaction so a failed write never
		// leaves a row in the ledger without the corresponding state.
		// ------------------------------------------------------------------
		const sharedMetadata = {
			documentRefKind: input.documentRefKind,
			documentRefId: input.documentRefId,
		};
		if (createdNewConversation && createdJoinId !== null) {
			recordAuditFromRequest(context, {
				action: "document_assistant.conversation.created",
				category: "project",
				organizationId: organizationId ?? null,
				projectId: input.projectId,
				resource: {
					type: "document_assistant_conversation",
					id: targetConversationId,
				},
				metadata: {
					...sharedMetadata,
					visibility: input.requestedVisibility ?? "SHARED",
				},
			});
		}
		if (result.spilledTo) {
			recordAuditFromRequest(context, {
				action: "document_assistant.conversation.spilled",
				category: "project",
				organizationId: organizationId ?? null,
				projectId: input.projectId,
				resource: {
					type: "document_assistant_conversation",
					id: result.spilledTo,
				},
				metadata: {
					...sharedMetadata,
					fromConversationId:
						"spilledFromConversationId" in result
							? (result as { spilledFromConversationId: string })
									.spilledFromConversationId
							: targetConversationId,
					toConversationId: result.spilledTo,
					reason: "cap_exceeded",
				},
			});
		}

		return {
			conversationId: result.conversationId,
			persistedAt: result.persistedAt,
			...(result.spilledTo ? { spilledTo: result.spilledTo } : {}),
		};
	});

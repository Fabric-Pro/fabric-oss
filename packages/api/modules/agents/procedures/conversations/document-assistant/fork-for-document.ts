/**
 * `agents.conversations.forkForDocument`.
 *
 * Atomic fork of a source conversation. Copies the source's `messages[0..N]`
 * (inclusive of `atMessageId`, or the full thread when omitted) into a new
 * `AgentConversation` + `DocumentAssistantConversation` join row, preserving
 * attachments and toolCalls so the forked thread has the full context the
 * agent needs to continue from that point.
 *
 * Order matches the other write paths (`appendTurnForDocument`):
 *   1. Feature-flag gate
 *   2. 50/day soft cap (a fork counts as a new conversation per FR-11)
 *   3. Ownership check on the source conversation
 *   4. Locate the fork slice (`messages[0..atMessageId]` inclusive)
 *   5. Sanity check: slice must contain at least one user message —
 *      otherwise there's no real anchor to continue from
 *   6. Create the new conversation row with the slice as initial
 *      `messages[]`; visibility lock is stamped because the slice already
 *      contains a user message
 *   7. Create the matching `DocumentAssistantConversation` join row with
 *      `parentConversationId` set so the History drawer can stitch the
 *      fork lineage
 *
 * Returns `{ conversationId, persistedAt, copiedMessageCount }` shape so the
 * client can immediately switch the live chat over without a round-trip to
 * `getActiveForDocument`.
 *
 * Spec §3.6 FR-19 (Fork capability). See the spec doc for the precise
 * acceptance criteria.
 */

import { ORPCError } from "@orpc/server";
import {
	countDocumentAssistantConversationsInLast24h,
	db,
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
	NEW_CONVERSATIONS_PER_DAY_CAP,
	NEW_CONVERSATIONS_PER_DAY_MESSAGE,
} from "./_shared";

export const forkForDocument = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/agents/conversations/document-assistant/fork",
		tags: ["Agent Conversations", "Document Assistant"],
		summary: "Fork a conversation from a point",
		description:
			"Atomically copy a source conversation's messages[0..atMessageId] (inclusive) into a new conversation row scoped to the same document, preserving attachments + toolCalls so the forked thread carries the same agent context. When `atMessageId` is omitted the entire source is copied. The new conversation becomes a sibling of the source under the History drawer.",
	})
	.input(
		DocumentRefSchema.extend({
			/** ID of the conversation to fork from. Must belong to the
			 * authenticated user and the same document scope as `documentRef`. */
			sourceConversationId: z.string().min(1),
			/** Cut the fork at this message id (inclusive). Omit to copy the
			 * entire source. */
			atMessageId: z.string().min(1).optional(),
			/** Visibility for the forked conversation. Defaults to inheriting
			 * the source's visibility — keeps the user's privacy choice in
			 * lockstep without an extra UI toggle. */
			requestedVisibility: DocumentAssistantVisibilitySchema.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// ----------------------------------------------------------------
		// 1. Feature-flag gate (org context only)
		// ----------------------------------------------------------------
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

		// ----------------------------------------------------------------
		// 2. 50/day soft cap — a fork is a new conversation row, so it
		//    counts against the same cap as a lazy-create.
		// ----------------------------------------------------------------
		const dailyCount = await countDocumentAssistantConversationsInLast24h({
			userId: user.id,
			documentRefKind: input.documentRefKind,
			documentRefId: input.documentRefId,
		});
		if (dailyCount >= NEW_CONVERSATIONS_PER_DAY_CAP) {
			throw new ORPCError("CONFLICT", {
				message: NEW_CONVERSATIONS_PER_DAY_MESSAGE,
			});
		}

		// ----------------------------------------------------------------
		// 3. Ownership check on the source — load the join row + the
		//    AgentConversation in one transaction so the fork is atomic.
		// ----------------------------------------------------------------
		const result = await db.$transaction(async (tx) => {
			const sourceJoin =
				await tx.documentAssistantConversation.findUnique({
					where: { conversationId: input.sourceConversationId },
					select: {
						id: true,
						userId: true,
						organizationId: true,
						projectId: true,
						documentRefKind: true,
						documentRefId: true,
						visibility: true,
					},
				});
			if (
				!sourceJoin ||
				sourceJoin.userId !== user.id ||
				(sourceJoin.organizationId ?? null) !==
					(organizationId ?? null) ||
				sourceJoin.documentRefKind !== input.documentRefKind ||
				sourceJoin.documentRefId !== input.documentRefId ||
				sourceJoin.projectId !== input.projectId
			) {
				// Hide the row's existence from cross-tenant / cross-document
				// callers (matches the convention in append/get/etc).
				throw new ORPCError("NOT_FOUND", {
					message: "Source conversation not found",
				});
			}

			const sourceConversation = await tx.agentConversation.findUnique({
				where: { id: input.sourceConversationId },
				select: { id: true, agentId: true, messages: true },
			});
			if (!sourceConversation) {
				throw new ORPCError("NOT_FOUND", {
					message: "Source conversation not found",
				});
			}

			// ------------------------------------------------------------
			// 4. Locate the fork slice. `messages` is JSON; if it isn't an
			//    array something has gone wrong upstream and we refuse to
			//    create a fork from corrupted state.
			// ------------------------------------------------------------
			const sourceMessages = Array.isArray(sourceConversation.messages)
				? (sourceConversation.messages as unknown[])
				: null;
			if (!sourceMessages) {
				throw new ORPCError("CONFLICT", {
					message: "Source conversation has no readable messages",
				});
			}

			let sliceEnd: number;
			if (input.atMessageId) {
				const idx = sourceMessages.findIndex(
					(m) =>
						m &&
						typeof m === "object" &&
						(m as { id?: unknown }).id === input.atMessageId,
				);
				if (idx === -1) {
					throw new ORPCError("NOT_FOUND", {
						message: "Fork-at message not found in source",
					});
				}
				sliceEnd = idx + 1; // inclusive
			} else {
				sliceEnd = sourceMessages.length;
			}
			const forkSlice = sourceMessages.slice(0, sliceEnd);

			// ------------------------------------------------------------
			// 5. Sanity check — the slice must contain at least one user
			//    message. Otherwise we'd be creating a "conversation" that
			//    only has greeting/system content and can't be continued
			//    coherently. The chip lock semantics also require a user
			//    message to stamp `visibilityLockedAt`.
			// ------------------------------------------------------------
			const hasUserMessage = forkSlice.some(
				(m) =>
					m &&
					typeof m === "object" &&
					(m as { role?: unknown }).role === "user",
			);
			if (!hasUserMessage) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Cannot fork from this point — the selected slice contains no user message",
				});
			}

			// ------------------------------------------------------------
			// 6. Create the new AgentConversation with the slice as
			//    initial messages. We deep-copy the slice via JSON
			//    round-trip so the new row's `messages` JSON is fully
			//    independent of the source (Prisma's JSON serialiser
			//    handles shared references but defensively cloning here
			//    keeps any downstream mutator from leaking back into the
			//    parent).
			// ------------------------------------------------------------
			const clonedSlice = JSON.parse(
				JSON.stringify(forkSlice),
			) as unknown[];

			const visibility =
				input.requestedVisibility ?? sourceJoin.visibility;

			const forkedConversation = await tx.agentConversation.create({
				data: {
					userId: user.id,
					organizationId: organizationId ?? null,
					agentId: sourceConversation.agentId,
					messages: clonedSlice as unknown as never,
					parentConversationId: input.sourceConversationId,
				},
			});

			// ------------------------------------------------------------
			// 7. Create the matching join row. visibilityLockedAt is
			//    stamped because the slice already contains a user
			//    message — the fork inherits the source's lock semantics
			//    by definition.
			// ------------------------------------------------------------
			const forkedJoin = await tx.documentAssistantConversation.create({
				data: {
					conversationId: forkedConversation.id,
					projectId: sourceJoin.projectId,
					organizationId: sourceJoin.organizationId,
					userId: user.id,
					documentRefKind: sourceJoin.documentRefKind,
					documentRefId: sourceJoin.documentRefId,
					visibility,
					visibilityLockedAt: new Date(),
				},
			});

			return {
				forkedConversationId: forkedConversation.id,
				forkedJoinId: forkedJoin.id,
				persistedAt: forkedJoin.updatedAt.toISOString(),
				copiedMessageCount: clonedSlice.length,
				visibility,
			};
		});

		// ----------------------------------------------------------------
		// 8. Audit trail — record the fork as a write so the audit log
		//    surfaces it the same way as appendTurn / rename / delete.
		//    Stays outside the transaction so a slow audit-log writer
		//    never holds the row lock.
		// ----------------------------------------------------------------
		recordAuditFromRequest(context, {
			action: "document_assistant.conversation.forked",
			category: "project",
			organizationId: organizationId ?? null,
			projectId: input.projectId,
			resource: {
				type: "document_assistant_conversation",
				id: result.forkedConversationId,
			},
			metadata: {
				sourceConversationId: input.sourceConversationId,
				atMessageId: input.atMessageId ?? null,
				documentRefKind: input.documentRefKind,
				documentRefId: input.documentRefId,
				copiedMessageCount: result.copiedMessageCount,
				visibility: result.visibility,
			},
		});

		return result;
	});

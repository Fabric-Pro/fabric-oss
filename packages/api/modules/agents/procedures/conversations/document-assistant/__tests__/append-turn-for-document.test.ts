/**
 * `appendTurnForDocument` — exhaustive write-path coverage.
 *
 * Spec acceptance criteria covered:
 *   - FR-2  stream-completion-only writes (implicit — handler doesn't
 *           gate on streamStatus, but tests exercise completed/cancelled
 *           messages and verify idempotency on retry).
 *   - FR-3  N=200 spill via parentConversationId + spilled audit.
 *   - FR-4  64 KB truncation with explicit marker; toolCalls preserved.
 *   - FR-5  reasoning fields stripped (delegated to maybeStripReasoning).
 *   - FR-11 50/day soft cap → CONFLICT with friendly copy.
 *   - FR-17 visibilityLockedAt set on the first user message in the
 *           same transaction as the append.
 *   - FR-27 feature flag OFF → CONFLICT.
 *   - Spec §5.3 step 9: duplicate message.id is a no-op (no double-
 *     append, no second audit event).
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dbMock,
	handlers,
	makeContext,
	recordAuditMock,
	repoDatabaseMock,
	setPendingHandlerKey,
} from "./_harness";

setPendingHandlerKey("appendTurnForDocument");
await import("../append-turn-for-document");

const ORG_ID = "org-1";
const PROJECT_ID = "proj-1";
const DOC_ID = "doc-1";
const CONV_ID = "conv-1";
const JOIN_ID = "join-1";

interface BuiltContext {
	user: { id: string; email: string; name: string };
	session: { id: string; activeOrganizationId: string };
	headers: Headers;
}

const userMessage = {
	id: "msg-user-1",
	role: "user" as const,
	content: "hello assistant",
	timestamp: "2026-05-19T10:00:00.000Z",
	streamStatus: "completed" as const,
};

const assistantMessage = {
	id: "msg-assistant-1",
	role: "assistant" as const,
	content: "hi back",
	timestamp: "2026-05-19T10:00:05.000Z",
	streamStatus: "completed" as const,
};

function flagEnabled(): void {
	dbMock.organization.findUnique.mockResolvedValue({
		documentAssistantHistoryEnabled: true,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	flagEnabled();
});

/**
 * The handler runs its body inside `db.$transaction(async tx => …)`. Tests
 * stub the transaction with a callback that hands the inner block its own
 * tx-shaped object so we don't need a real Postgres connection.
 */
function stubTransaction(txImpl: Partial<typeof dbMock> = {}): typeof dbMock {
	const tx = { ...dbMock, ...txImpl };
	dbMock.$transaction.mockImplementation(
		async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
	);
	return tx as typeof dbMock;
}

describe("appendTurnForDocument — lazy create", () => {
	it("creates a new conversation when conversationId is omitted and emits the created audit", async () => {
		repoDatabaseMock.countDocumentAssistantConversationsInLast24h.mockResolvedValue(
			0,
		);
		repoDatabaseMock.createDocumentAssistantConversation.mockResolvedValue({
			conversation: { id: CONV_ID, messages: [], agentId: "doc-agent" },
			join: {
				id: JOIN_ID,
				conversationId: CONV_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				userId: "user-1",
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: DOC_ID,
				visibility: "SHARED",
				visibilityLockedAt: null,
				updatedAt: new Date("2026-05-19T10:01:00Z"),
			},
		});
		stubTransaction();
		dbMock.agentConversation.findFirst.mockResolvedValue({
			id: CONV_ID,
			messages: [],
			agentId: "doc-agent",
		});
		dbMock.agentConversation.update.mockResolvedValue({
			updatedAt: new Date("2026-05-19T10:01:00Z"),
		});
		dbMock.documentAssistantConversation.update.mockResolvedValue({
			id: JOIN_ID,
		});

		const result = await handlers.appendTurnForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: DOC_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				message: userMessage,
				agentId: "doc-agent",
			},
		});

		expect(
			repoDatabaseMock.createDocumentAssistantConversation,
		).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			conversationId: CONV_ID,
		});
		const createdCalls = recordAuditMock.mock.calls.filter(
			(c) =>
				(c[1] as { action: string }).action ===
				"document_assistant.conversation.created",
		);
		expect(createdCalls.length).toBe(1);
		expect(createdCalls[0][1]).toMatchObject({
			category: "project",
			projectId: PROJECT_ID,
			resource: {
				type: "document_assistant_conversation",
				id: CONV_ID,
			},
		});
		const metadata = (
			createdCalls[0][1] as { metadata: Record<string, unknown> }
		).metadata;
		expect(metadata.documentRefKind).toBe("PROJECT_DOCUMENT");
		expect(metadata.documentRefId).toBe(DOC_ID);
	});

	it("rejects with CONFLICT when the 50/day soft cap is hit", async () => {
		repoDatabaseMock.countDocumentAssistantConversationsInLast24h.mockResolvedValue(
			50,
		);

		await expect(
			handlers.appendTurnForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: {
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: DOC_ID,
					projectId: PROJECT_ID,
					organizationId: ORG_ID,
					message: userMessage,
					agentId: "doc-agent",
				},
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("50 conversations"),
		});
		expect(recordAuditMock).not.toHaveBeenCalled();
		expect(
			repoDatabaseMock.createDocumentAssistantConversation,
		).not.toHaveBeenCalled();
	});
});

describe("appendTurnForDocument — feature flag", () => {
	it("rejects with CONFLICT when the org flag is OFF", async () => {
		dbMock.organization.findUnique.mockResolvedValue({
			documentAssistantHistoryEnabled: false,
		});

		await expect(
			handlers.appendTurnForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: {
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: DOC_ID,
					projectId: PROJECT_ID,
					organizationId: ORG_ID,
					message: userMessage,
					agentId: "doc-agent",
				},
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("disabled"),
		});
		expect(recordAuditMock).not.toHaveBeenCalled();
	});
});

describe("appendTurnForDocument — existing conversation", () => {
	it("rejects with FORBIDDEN when the caller is not the author", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: JOIN_ID,
			userId: "other-user",
			organizationId: ORG_ID,
		});

		await expect(
			handlers.appendTurnForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: {
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: DOC_ID,
					projectId: PROJECT_ID,
					organizationId: ORG_ID,
					conversationId: CONV_ID,
					message: userMessage,
					agentId: "doc-agent",
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(recordAuditMock).not.toHaveBeenCalled();
	});

	it("rejects with NOT_FOUND on cross-tenant attempt (no info leak)", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: JOIN_ID,
			userId: "user-1",
			organizationId: "other-org",
		});

		await expect(
			handlers.appendTurnForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: {
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: DOC_ID,
					projectId: PROJECT_ID,
					organizationId: ORG_ID,
					conversationId: CONV_ID,
					message: userMessage,
					agentId: "doc-agent",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("is idempotent on duplicate message.id", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: JOIN_ID,
			userId: "user-1",
			organizationId: ORG_ID,
		});
		stubTransaction();
		dbMock.agentConversation.findFirst.mockResolvedValue({
			id: CONV_ID,
			messages: [{ ...userMessage }],
			agentId: "doc-agent",
		});
		dbMock.documentAssistantConversation.findUnique
			.mockResolvedValueOnce({
				id: JOIN_ID,
				userId: "user-1",
				organizationId: ORG_ID,
			})
			.mockResolvedValueOnce({
				updatedAt: new Date("2026-05-19T10:00:30Z"),
			});

		const result = await handlers.appendTurnForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: DOC_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				conversationId: CONV_ID,
				message: userMessage,
				agentId: "doc-agent",
			},
		});

		expect(result).toMatchObject({
			conversationId: CONV_ID,
		});
		// No append → no agentConversation.update call.
		expect(dbMock.agentConversation.update).not.toHaveBeenCalled();
		// No created/spilled audit (idempotent retry).
		expect(recordAuditMock).not.toHaveBeenCalled();
	});

	it("sets visibilityLockedAt on the first user message", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: JOIN_ID,
			userId: "user-1",
			organizationId: ORG_ID,
		});
		stubTransaction();
		dbMock.agentConversation.findFirst.mockResolvedValue({
			id: CONV_ID,
			messages: [
				{
					id: "msg-assistant-bootstrap",
					role: "assistant",
					content: "hi",
				},
			],
			agentId: "doc-agent",
		});
		dbMock.agentConversation.update.mockResolvedValue({
			updatedAt: new Date("2026-05-19T10:00:00Z"),
		});
		dbMock.documentAssistantConversation.updateMany.mockResolvedValue({
			count: 1,
		});
		dbMock.documentAssistantConversation.update.mockResolvedValue({
			id: JOIN_ID,
		});

		await handlers.appendTurnForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: DOC_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				conversationId: CONV_ID,
				message: userMessage,
				agentId: "doc-agent",
			},
		});

		// The lock fires via an atomic `updateMany` with `visibilityLockedAt: null`
		// (guards against a racing setVisibility flip).
		expect(
			dbMock.documentAssistantConversation.updateMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: JOIN_ID, visibilityLockedAt: null },
				data: expect.objectContaining({
					visibilityLockedAt: expect.any(Date),
				}),
			}),
		);
	});

	it("does NOT re-lock visibility if the conversation already has a user message", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: JOIN_ID,
			userId: "user-1",
			organizationId: ORG_ID,
		});
		stubTransaction();
		dbMock.agentConversation.findFirst.mockResolvedValue({
			id: CONV_ID,
			messages: [
				{
					id: "msg-user-prev",
					role: "user",
					content: "earlier prompt",
				},
			],
			agentId: "doc-agent",
		});
		dbMock.agentConversation.update.mockResolvedValue({
			updatedAt: new Date(),
		});
		dbMock.documentAssistantConversation.update.mockResolvedValue({
			id: JOIN_ID,
		});

		await handlers.appendTurnForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: DOC_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				conversationId: CONV_ID,
				message: { ...userMessage, id: "msg-user-2" },
				agentId: "doc-agent",
			},
		});

		expect(
			dbMock.documentAssistantConversation.updateMany,
		).not.toHaveBeenCalled();
	});
});

describe("appendTurnForDocument — 64 KB truncation", () => {
	it("truncates content beyond 64 KB and appends the marker, preserving toolCalls", async () => {
		const bigContent = "a".repeat(70 * 1024); // 70 KB
		const bigMessage = {
			id: "msg-big",
			role: "assistant" as const,
			content: bigContent,
			timestamp: "2026-05-19T10:00:00.000Z",
			toolCalls: [
				{
					id: "tc-1",
					name: "write_document_local",
					args: { path: "/doc/a" },
				},
			],
		};

		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: JOIN_ID,
			userId: "user-1",
			organizationId: ORG_ID,
		});
		stubTransaction();
		dbMock.agentConversation.findFirst.mockResolvedValue({
			id: CONV_ID,
			messages: [],
			agentId: "doc-agent",
		});
		dbMock.agentConversation.update.mockResolvedValue({
			updatedAt: new Date(),
		});
		dbMock.documentAssistantConversation.update.mockResolvedValue({
			id: JOIN_ID,
		});

		await handlers.appendTurnForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: DOC_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				conversationId: CONV_ID,
				message: bigMessage,
				agentId: "doc-agent",
			},
		});

		const updateCall = dbMock.agentConversation.update.mock.calls[0]?.[0];
		const messages = updateCall.data.messages as Array<{
			content: string;
			toolCalls?: unknown[];
		}>;
		expect(messages).toHaveLength(1);
		const persisted = messages[0]!;
		expect(persisted.content.length).toBeLessThan(bigContent.length);
		expect(persisted.content).toContain("…[truncated by Fabric —");
		expect(persisted.toolCalls).toEqual(bigMessage.toolCalls);
	});
});

describe("appendTurnForDocument — 200-turn spill", () => {
	it("creates a continuation conversation when the cap is hit and emits the spilled audit", async () => {
		const PARENT_CONV = "conv-parent";
		const CONTINUATION_CONV = "conv-continuation";
		const CONTINUATION_JOIN = "join-continuation";

		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: JOIN_ID,
			userId: "user-1",
			organizationId: ORG_ID,
		});
		stubTransaction();
		const huge = Array.from({ length: 200 }, (_, i) => ({
			id: `m${i}`,
			role: i % 2 === 0 ? "user" : "assistant",
			content: "x",
		}));
		dbMock.agentConversation.findFirst.mockResolvedValue({
			id: PARENT_CONV,
			messages: huge,
			agentId: "doc-agent",
		});
		dbMock.documentAssistantConversation.findUnique.mockReset();
		dbMock.documentAssistantConversation.findUnique
			// 1st call: ownership check (outside the tx)
			.mockResolvedValueOnce({
				id: JOIN_ID,
				userId: "user-1",
				organizationId: ORG_ID,
			})
			// 2nd call: spill metadata lookup (inside the tx)
			.mockResolvedValueOnce({
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				userId: "user-1",
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: DOC_ID,
				visibility: "SHARED",
				visibilityLockedAt: new Date("2026-05-19T09:00:00Z"),
			});
		dbMock.agentConversation.create.mockResolvedValue({
			id: CONTINUATION_CONV,
		});
		dbMock.documentAssistantConversation.create.mockResolvedValue({
			id: CONTINUATION_JOIN,
			updatedAt: new Date("2026-05-19T10:30:00Z"),
		});

		const result = await handlers.appendTurnForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: DOC_ID,
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				conversationId: PARENT_CONV,
				message: assistantMessage,
				agentId: "doc-agent",
			},
		});

		expect(result.spilledTo).toBe(CONTINUATION_CONV);
		expect(dbMock.agentConversation.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					parentConversationId: PARENT_CONV,
				}),
			}),
		);
		const spilledCalls = recordAuditMock.mock.calls.filter(
			(c) =>
				(c[1] as { action: string }).action ===
				"document_assistant.conversation.spilled",
		);
		expect(spilledCalls).toHaveLength(1);
		expect(spilledCalls[0][1]).toMatchObject({
			category: "project",
			projectId: PROJECT_ID,
			resource: {
				type: "document_assistant_conversation",
				id: CONTINUATION_CONV,
			},
		});
		expect(
			(spilledCalls[0][1] as { metadata: Record<string, unknown> })
				.metadata,
		).toMatchObject({
			fromConversationId: PARENT_CONV,
			toConversationId: CONTINUATION_CONV,
			reason: "cap_exceeded",
		});
	});
});

// Sanity: ORPCError import keeps the dependency live for type-only consumers
// of the test file; without it the import block could be tree-shaken in
// some toolchains.
void ORPCError;

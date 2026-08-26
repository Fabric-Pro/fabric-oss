/**
 * Audit-log emission contract for document-assistant lifecycle events.
 * Spec §3.6 FR-21, §8, AC-10.
 *
 * For each of the six lifecycle events the procedure surface MUST emit
 * exactly one `recordAuditFromRequest` call with the spec-mandated shape:
 *
 *   - action:        "document_assistant.conversation.<event>"
 *   - category:      "project"
 *   - resource.type: "document_assistant_conversation"
 *   - resource.id:   the conversationId
 *   - projectId:     the parent project
 *   - metadata:      { documentRefKind, documentRefId, ...event-specific }
 *
 * Severity defaults to "info" and outcome to "success" via
 * `buildAuditRow` in `@repo/database/queries/audit-log.ts` (we do not
 * override here).
 *
 * Failure paths (50/day cap, feature-flag CONFLICT, FORBIDDEN,
 * NOT_FOUND) MUST emit ZERO audit rows (spec §8 — failures stay out of
 * the audit ledger).
 *
 * Spilled, renamed, visibility_changed audit-shape assertions live in
 * the per-procedure test files; this one is a one-shot guarantor that
 * the closed set of six lifecycle actions all land in the spec shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dbMock,
	handlers,
	makeContext,
	recordAuditMock,
	repoDatabaseMock,
	setPendingHandlerKey,
} from "../../agents/procedures/conversations/document-assistant/__tests__/_harness";

setPendingHandlerKey("appendTurnForDocument");
await import(
	"../../agents/procedures/conversations/document-assistant/append-turn-for-document"
);

setPendingHandlerKey("setVisibilityForDocument");
await import(
	"../../agents/procedures/conversations/document-assistant/set-visibility-for-document"
);

setPendingHandlerKey("archiveForDocument");
await import(
	"../../agents/procedures/conversations/document-assistant/archive-for-document"
);

setPendingHandlerKey("deleteForDocument");
await import(
	"../../agents/procedures/conversations/document-assistant/delete-for-document"
);

setPendingHandlerKey("renameForDocument");
await import(
	"../../agents/procedures/conversations/document-assistant/rename-for-document"
);

interface BuiltContext {
	user: { id: string; email: string; name: string };
	session: { id: string; activeOrganizationId: string };
	headers: Headers;
}

const baseMetadata = {
	documentRefKind: "PROJECT_DOCUMENT",
	documentRefId: "doc-1",
};

const ownedRow = {
	id: "join-1",
	userId: "user-1",
	organizationId: "org-1",
	projectId: "proj-1",
	documentRefKind: "PROJECT_DOCUMENT" as const,
	documentRefId: "doc-1",
	visibility: "SHARED" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.organization.findUnique.mockResolvedValue({
		documentAssistantHistoryEnabled: true,
	});
});

function getAuditCall(action: string) {
	const match = recordAuditMock.mock.calls.find(
		(c) => (c[1] as { action: string } | undefined)?.action === action,
	);
	expect(match, `expected exactly one ${action} call`).toBeTruthy();
	return match![1] as Record<string, unknown>;
}

describe("document_assistant.conversation.created", () => {
	it("writes one row with the spec-mandated shape", async () => {
		repoDatabaseMock.countDocumentAssistantConversationsInLast24h.mockResolvedValue(
			0,
		);
		repoDatabaseMock.createDocumentAssistantConversation.mockResolvedValue({
			conversation: {
				id: "conv-new",
				messages: [],
				agentId: "doc-agent",
			},
			join: {
				id: "join-new",
				userId: "user-1",
				organizationId: "org-1",
				projectId: "proj-1",
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				visibility: "SHARED",
				visibilityLockedAt: null,
				updatedAt: new Date(),
			},
		});
		dbMock.$transaction.mockImplementation(
			async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock),
		);
		dbMock.agentConversation.findFirst.mockResolvedValue({
			id: "conv-new",
			messages: [],
			agentId: "doc-agent",
		});
		dbMock.agentConversation.update.mockResolvedValue({
			updatedAt: new Date(),
		});

		await handlers.appendTurnForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
				agentId: "doc-agent",
				message: {
					id: "msg-1",
					role: "user",
					content: "hi",
					timestamp: "2026-05-19T10:00:00.000Z",
				},
				requestedVisibility: "PRIVATE",
			},
		});

		const payload = getAuditCall("document_assistant.conversation.created");
		expect(payload).toMatchObject({
			action: "document_assistant.conversation.created",
			category: "project",
			organizationId: "org-1",
			projectId: "proj-1",
			resource: {
				type: "document_assistant_conversation",
				id: "conv-new",
			},
		});
		expect(payload.metadata).toMatchObject({
			...baseMetadata,
			visibility: "PRIVATE",
		});
	});
});

describe("document_assistant.conversation.archived", () => {
	it("writes one row with documentRefKind + documentRefId metadata", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			ownedRow,
		);
		repoDatabaseMock.archiveDocumentAssistantConversation.mockResolvedValue(
			{
				id: "join-1",
				archivedAt: new Date(),
			},
		);

		await handlers.archiveForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: { conversationId: "conv-1", organizationId: "org-1" },
		});

		const payload = getAuditCall(
			"document_assistant.conversation.archived",
		);
		expect(payload).toMatchObject({
			category: "project",
			projectId: "proj-1",
			resource: {
				type: "document_assistant_conversation",
				id: "conv-1",
			},
		});
		expect(payload.metadata).toMatchObject(baseMetadata);
	});
});

describe("document_assistant.conversation.deleted", () => {
	it("writes one row BEFORE the delete (resourceId snapshot live)", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			ownedRow,
		);
		const order: string[] = [];
		recordAuditMock.mockImplementation(() => order.push("audit"));
		repoDatabaseMock.deleteDocumentAssistantConversationByConversationId.mockImplementation(
			async () => {
				order.push("delete");
			},
		);

		await handlers.deleteForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: { conversationId: "conv-1", organizationId: "org-1" },
		});

		expect(order).toEqual(["audit", "delete"]);
		const payload = getAuditCall("document_assistant.conversation.deleted");
		expect(payload).toMatchObject({
			category: "project",
			projectId: "proj-1",
			resource: {
				type: "document_assistant_conversation",
				id: "conv-1",
			},
		});
		expect(payload.metadata).toMatchObject(baseMetadata);
	});
});

describe("document_assistant.conversation.renamed", () => {
	it("writes one row with { from, to } in metadata", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			...ownedRow,
			conversation: { id: "conv-1", title: "Old" },
		});
		dbMock.agentConversation.update.mockResolvedValue({
			id: "conv-1",
			title: "New",
		});

		await handlers.renameForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				conversationId: "conv-1",
				organizationId: "org-1",
				title: "New",
			},
		});

		const payload = getAuditCall("document_assistant.conversation.renamed");
		expect(payload.metadata).toMatchObject({
			from: "Old",
			to: "New",
			...baseMetadata,
		});
	});
});

describe("document_assistant.conversation.visibility_changed", () => {
	it("writes one row with { from, to } in metadata", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			...ownedRow,
			visibility: "SHARED",
		});
		repoDatabaseMock.setDocumentAssistantConversationVisibility.mockResolvedValue(
			{
				id: "join-1",
				visibility: "PRIVATE",
				visibilityLockedAt: null,
			},
		);

		await handlers.setVisibilityForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				conversationId: "conv-1",
				organizationId: "org-1",
				visibility: "PRIVATE",
			},
		});

		const payload = getAuditCall(
			"document_assistant.conversation.visibility_changed",
		);
		expect(payload.metadata).toMatchObject({
			from: "SHARED",
			to: "PRIVATE",
			...baseMetadata,
		});
	});
});

describe("document_assistant.conversation.spilled", () => {
	it("writes one row with { fromConversationId, toConversationId, reason: 'cap_exceeded' }", async () => {
		const PARENT = "conv-parent";
		const CONTINUATION = "conv-continuation";
		dbMock.documentAssistantConversation.findUnique.mockResolvedValueOnce({
			id: "join-parent",
			userId: "user-1",
			organizationId: "org-1",
		});
		dbMock.$transaction.mockImplementation(
			async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock),
		);
		dbMock.agentConversation.findFirst.mockResolvedValue({
			id: PARENT,
			messages: Array.from({ length: 200 }, (_, i) => ({
				id: `m${i}`,
				role: "user",
				content: "x",
			})),
			agentId: "doc-agent",
		});
		dbMock.documentAssistantConversation.findUnique.mockResolvedValueOnce({
			projectId: "proj-1",
			organizationId: "org-1",
			userId: "user-1",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			visibility: "SHARED",
			visibilityLockedAt: new Date(),
		});
		dbMock.agentConversation.create.mockResolvedValue({ id: CONTINUATION });
		dbMock.documentAssistantConversation.create.mockResolvedValue({
			id: "join-continuation",
			updatedAt: new Date(),
		});

		await handlers.appendTurnForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
				conversationId: PARENT,
				agentId: "doc-agent",
				message: {
					id: "msg-201",
					role: "assistant",
					content: "spilling",
					timestamp: "2026-05-19T10:00:00.000Z",
				},
			},
		});

		const payload = getAuditCall("document_assistant.conversation.spilled");
		expect(payload).toMatchObject({
			category: "project",
			projectId: "proj-1",
			resource: {
				type: "document_assistant_conversation",
				id: CONTINUATION,
			},
		});
		expect(payload.metadata).toMatchObject({
			fromConversationId: PARENT,
			toConversationId: CONTINUATION,
			reason: "cap_exceeded",
			...baseMetadata,
		});
	});
});

describe("failures do NOT emit audit rows", () => {
	it("50/day cap CONFLICT → no audit", async () => {
		repoDatabaseMock.countDocumentAssistantConversationsInLast24h.mockResolvedValue(
			50,
		);

		await expect(
			handlers.appendTurnForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: {
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: "doc-1",
					projectId: "proj-1",
					organizationId: "org-1",
					agentId: "doc-agent",
					message: {
						id: "msg-1",
						role: "user",
						content: "hi",
						timestamp: "2026-05-19T10:00:00.000Z",
					},
				},
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(recordAuditMock).not.toHaveBeenCalled();
	});

	it("feature-flag CONFLICT → no audit", async () => {
		dbMock.organization.findUnique.mockResolvedValue({
			documentAssistantHistoryEnabled: false,
		});

		await expect(
			handlers.appendTurnForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: {
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: "doc-1",
					projectId: "proj-1",
					organizationId: "org-1",
					agentId: "doc-agent",
					message: {
						id: "msg-1",
						role: "user",
						content: "hi",
						timestamp: "2026-05-19T10:00:00.000Z",
					},
				},
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(recordAuditMock).not.toHaveBeenCalled();
	});

	it("FORBIDDEN rename → no audit", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			...ownedRow,
			userId: "other-user",
			conversation: { id: "conv-1", title: "T" },
		});

		await expect(
			handlers.renameForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: {
					conversationId: "conv-1",
					organizationId: "org-1",
					title: "Hijack",
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(recordAuditMock).not.toHaveBeenCalled();
	});
});

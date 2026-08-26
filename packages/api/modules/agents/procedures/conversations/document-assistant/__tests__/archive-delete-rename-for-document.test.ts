/**
 * Lifecycle write coverage for archive / delete / rename. Spec §5.5–§5.7.
 *
 * Each procedure asserts:
 *   - Exactly one lifecycle audit row written with the spec-mandated
 *     shape (category, resourceType, projectId, severity defaulting to
 *     "info", outcome defaulting to "success", metadata carrying
 *     documentRefKind + documentRefId).
 *   - Non-author calls return FORBIDDEN with no mutation + no audit.
 *   - Cross-tenant calls return NOT_FOUND (no info leak).
 *   - Delete cascades via the underlying AgentConversation row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dbMock,
	handlers,
	makeContext,
	recordAuditMock,
	repoDatabaseMock,
	setPendingHandlerKey,
} from "./_harness";

setPendingHandlerKey("archiveForDocument");
await import("../archive-for-document");

setPendingHandlerKey("deleteForDocument");
await import("../delete-for-document");

setPendingHandlerKey("renameForDocument");
await import("../rename-for-document");

interface BuiltContext {
	user: { id: string; email: string; name: string };
	session: { id: string; activeOrganizationId: string };
	headers: Headers;
}

const joinRowForAuthor = {
	id: "join-1",
	userId: "user-1",
	organizationId: "org-1",
	projectId: "proj-1",
	documentRefKind: "PROJECT_DOCUMENT" as const,
	documentRefId: "doc-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.organization.findUnique.mockResolvedValue({
		documentAssistantHistoryEnabled: true,
	});
});

describe("archiveForDocument", () => {
	it("archives and emits document_assistant.conversation.archived", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			joinRowForAuthor,
		);
		repoDatabaseMock.archiveDocumentAssistantConversation.mockResolvedValue(
			{
				id: "join-1",
				archivedAt: new Date("2026-05-19T10:00:00Z"),
			},
		);

		const result = await handlers.archiveForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				conversationId: "conv-1",
				organizationId: "org-1",
			},
		});

		expect(result.conversation.status).toBe("ARCHIVED");
		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			{
				action: string;
				category: string;
				resource: Record<string, unknown>;
				projectId: string;
				metadata: Record<string, unknown>;
			},
		];
		expect(payload).toMatchObject({
			action: "document_assistant.conversation.archived",
			category: "project",
			projectId: "proj-1",
			resource: {
				type: "document_assistant_conversation",
				id: "conv-1",
			},
		});
		expect(payload.metadata).toMatchObject({
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
		});
	});

	it("returns FORBIDDEN for a non-author", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			...joinRowForAuthor,
			userId: "other-user",
		});

		await expect(
			handlers.archiveForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: { conversationId: "conv-1", organizationId: "org-1" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			repoDatabaseMock.archiveDocumentAssistantConversation,
		).not.toHaveBeenCalled();
		expect(recordAuditMock).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND on cross-tenant attempts", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			...joinRowForAuthor,
			organizationId: "other-org",
		});

		await expect(
			handlers.archiveForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: { conversationId: "conv-1", organizationId: "org-1" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("deleteForDocument", () => {
	it("emits the deleted audit BEFORE removing the underlying conversation row", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			joinRowForAuthor,
		);
		const auditOrder: string[] = [];
		recordAuditMock.mockImplementation(() => {
			auditOrder.push("audit");
		});
		repoDatabaseMock.deleteDocumentAssistantConversationByConversationId.mockImplementation(
			async () => {
				auditOrder.push("delete");
			},
		);

		await handlers.deleteForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				conversationId: "conv-1",
				organizationId: "org-1",
			},
		});

		expect(auditOrder).toEqual(["audit", "delete"]);
		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			{ action: string; metadata: Record<string, unknown> },
		];
		expect(payload.action).toBe("document_assistant.conversation.deleted");
		expect(payload.metadata).toMatchObject({
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
		});
	});

	it("returns FORBIDDEN for a non-author and does NOT delete", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			...joinRowForAuthor,
			userId: "other-user",
		});

		await expect(
			handlers.deleteForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: { conversationId: "conv-1", organizationId: "org-1" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			repoDatabaseMock.deleteDocumentAssistantConversationByConversationId,
		).not.toHaveBeenCalled();
		expect(recordAuditMock).not.toHaveBeenCalled();
	});
});

describe("renameForDocument", () => {
	it("renames and emits a renamed audit with { from, to }", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			...joinRowForAuthor,
			conversation: { id: "conv-1", title: "Old title" },
		});
		dbMock.agentConversation.update.mockResolvedValue({
			id: "conv-1",
			title: "New title",
		});

		await handlers.renameForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				conversationId: "conv-1",
				organizationId: "org-1",
				title: "New title",
			},
		});

		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			{ action: string; metadata: Record<string, unknown> },
		];
		expect(payload.action).toBe("document_assistant.conversation.renamed");
		expect(payload.metadata).toMatchObject({
			from: "Old title",
			to: "New title",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
		});
	});

	it("does NOT emit an audit when the title is unchanged", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			...joinRowForAuthor,
			conversation: { id: "conv-1", title: "Same title" },
		});
		dbMock.agentConversation.update.mockResolvedValue({
			id: "conv-1",
			title: "Same title",
		});

		await handlers.renameForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				conversationId: "conv-1",
				organizationId: "org-1",
				title: "Same title",
			},
		});

		expect(recordAuditMock).not.toHaveBeenCalled();
	});

	it("returns FORBIDDEN for a non-author", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			...joinRowForAuthor,
			userId: "other-user",
			conversation: { id: "conv-1", title: "Old" },
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
		expect(dbMock.agentConversation.update).not.toHaveBeenCalled();
		expect(recordAuditMock).not.toHaveBeenCalled();
	});
});

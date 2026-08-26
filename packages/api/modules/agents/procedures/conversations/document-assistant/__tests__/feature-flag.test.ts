/**
 * Feature-flag gating across the whole document-assistant surface.
 * Spec §3.11 FR-27 / AC-15.
 *
 *   - When `Organization.documentAssistantHistoryEnabled = false`:
 *     - list returns { items: [], nextCursor: null }
 *     - get returns { conversation: null }
 *     - every write path returns CONFLICT with the spec copy
 *
 *   - Personal-context callers are always treated as enabled (the org
 *     lookup is skipped entirely; behaviour matches an enabled tenant).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dbMock,
	handlers,
	makeContext,
	repoDatabaseMock,
	setPendingHandlerKey,
} from "./_harness";

setPendingHandlerKey("listForDocument");
await import("../list-for-document");

setPendingHandlerKey("getActiveForDocument");
await import("../get-active-for-document");

setPendingHandlerKey("appendTurnForDocument");
await import("../append-turn-for-document");

setPendingHandlerKey("setVisibilityForDocument");
await import("../set-visibility-for-document");

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

const refInput = {
	documentRefKind: "PROJECT_DOCUMENT" as const,
	documentRefId: "doc-1",
	projectId: "proj-1",
	organizationId: "org-1",
};

function disableFlag(): void {
	dbMock.organization.findUnique.mockResolvedValue({
		documentAssistantHistoryEnabled: false,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("feature flag — reads return empty/null", () => {
	beforeEach(disableFlag);

	it("list returns empty payload", async () => {
		const r = await handlers.listForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: { ...refInput, limit: 10 },
		});
		expect(r).toEqual({ items: [], nextCursor: null });
	});

	it("getActive returns null", async () => {
		const r = await handlers.getActiveForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: refInput,
		});
		expect(r).toEqual({ conversation: null });
	});
});

describe("feature flag — writes return CONFLICT", () => {
	beforeEach(disableFlag);

	const ownedRow = {
		id: "join-1",
		userId: "user-1",
		organizationId: "org-1",
		projectId: "proj-1",
		documentRefKind: "PROJECT_DOCUMENT" as const,
		documentRefId: "doc-1",
		visibility: "SHARED" as const,
	};

	it("appendTurnForDocument", async () => {
		await expect(
			handlers.appendTurnForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: {
					...refInput,
					conversationId: "conv-1",
					agentId: "doc-agent",
					message: {
						id: "msg-1",
						role: "user",
						content: "hi",
						timestamp: "2026-05-19T10:00:00.000Z",
					},
				},
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("disabled"),
		});
	});

	it("setVisibilityForDocument", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			ownedRow,
		);
		await expect(
			handlers.setVisibilityForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: {
					conversationId: "conv-1",
					organizationId: "org-1",
					visibility: "PRIVATE",
				},
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("archiveForDocument", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			ownedRow,
		);
		await expect(
			handlers.archiveForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: { conversationId: "conv-1", organizationId: "org-1" },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("deleteForDocument", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			ownedRow,
		);
		await expect(
			handlers.deleteForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: { conversationId: "conv-1", organizationId: "org-1" },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("renameForDocument", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			...ownedRow,
			conversation: { id: "conv-1", title: "Title" },
		});
		await expect(
			handlers.renameForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: {
					conversationId: "conv-1",
					organizationId: "org-1",
					title: "Renamed",
				},
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("feature flag — personal context always enabled", () => {
	it("list never consults Organization.findUnique", async () => {
		repoDatabaseMock.listDocumentAssistantConversations.mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		await handlers.listForDocument({
			context: makeContext({
				session: {
					id: "sess-1",
					activeOrganizationId: null as unknown as string,
					impersonatedBy: null,
				} as unknown as never,
			}) as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: null,
				limit: 10,
			},
		});

		expect(dbMock.organization.findUnique).not.toHaveBeenCalled();
		expect(
			repoDatabaseMock.listDocumentAssistantConversations,
		).toHaveBeenCalled();
	});

	it("appendTurnForDocument never consults Organization.findUnique", async () => {
		repoDatabaseMock.countDocumentAssistantConversationsInLast24h.mockResolvedValue(
			0,
		);
		repoDatabaseMock.createDocumentAssistantConversation.mockResolvedValue({
			conversation: {
				id: "conv-personal",
				messages: [],
				agentId: "doc-agent",
			},
			join: {
				id: "join-personal",
				userId: "user-1",
				organizationId: null,
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
			id: "conv-personal",
			messages: [],
			agentId: "doc-agent",
		});
		dbMock.agentConversation.update.mockResolvedValue({
			updatedAt: new Date(),
		});

		await handlers.appendTurnForDocument({
			context: makeContext({
				session: {
					id: "sess-1",
					activeOrganizationId: null as unknown as string,
					impersonatedBy: null,
				} as unknown as never,
			}) as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: null,
				agentId: "doc-agent",
				message: {
					id: "msg-1",
					role: "user",
					content: "hi",
					timestamp: "2026-05-19T10:00:00.000Z",
				},
			},
		});

		expect(dbMock.organization.findUnique).not.toHaveBeenCalled();
	});
});

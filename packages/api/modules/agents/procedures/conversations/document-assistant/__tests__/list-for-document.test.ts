/**
 * `listForDocument` — visibility + tenant + feature-flag coverage.
 *
 * Spec acceptance criteria covered:
 *   - §5.1 cursor pagination plumbed through to the query helper.
 *   - FR-19 visibility predicate (SHARED + own PRIVATE) enforced
 *     inside the helper — this test verifies the procedure passes the
 *     right `tenantFilter.userId` and trusts the helper.
 *   - FR-20 / AC-11 tenant XOR (org context wins over personal).
 *   - FR-27 feature flag OFF returns `{ items: [], nextCursor: null }`.
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

interface BuiltContext {
	user: { id: string; email: string; name: string };
	session: { id: string; activeOrganizationId: string };
	headers: Headers;
}

const sampleRow = (
	id: string,
	userId: string,
	visibility: "SHARED" | "PRIVATE",
) => ({
	id,
	conversationId: `conv-${id}`,
	documentRefKind: "PROJECT_DOCUMENT" as const,
	documentRefId: "doc-1",
	projectId: "proj-1",
	organizationId: "org-1",
	userId,
	visibility,
	visibilityLockedAt: null,
	archivedAt: null,
	createdAt: new Date("2026-05-19T10:00:00Z"),
	updatedAt: new Date("2026-05-19T10:00:00Z"),
});

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.organization.findUnique.mockResolvedValue({
		documentAssistantHistoryEnabled: true,
	});
});

describe("listForDocument — feature flag", () => {
	it("returns empty when org flag is OFF", async () => {
		dbMock.organization.findUnique.mockResolvedValue({
			documentAssistantHistoryEnabled: false,
		});

		const result = await handlers.listForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
				limit: 10,
			},
		});

		expect(result).toEqual({ items: [], nextCursor: null });
		expect(
			repoDatabaseMock.listDocumentAssistantConversations,
		).not.toHaveBeenCalled();
	});

	it("personal context is always enabled (org lookup skipped)", async () => {
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
		).toHaveBeenCalledWith(
			expect.objectContaining({
				tenantFilter: { organizationId: null, userId: "user-1" },
			}),
		);
	});
});

describe("listForDocument — tenant XOR", () => {
	it("passes org tenantFilter on org-context calls", async () => {
		repoDatabaseMock.listDocumentAssistantConversations.mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		await handlers.listForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
				limit: 10,
			},
		});

		expect(
			repoDatabaseMock.listDocumentAssistantConversations,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				tenantFilter: { organizationId: "org-1", userId: "user-1" },
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
			}),
		);
	});
});

describe("listForDocument — hydration shape", () => {
	it("hydrates author + messageCount + preview from agentConversation + user", async () => {
		repoDatabaseMock.listDocumentAssistantConversations.mockResolvedValue({
			items: [sampleRow("a", "user-1", "PRIVATE")],
			nextCursor: "cursor-xyz",
		});
		dbMock.agentConversation.findMany.mockResolvedValue([
			{
				id: "conv-a",
				title: "Drafting kickoff",
				messages: [
					{
						id: "u1",
						role: "user",
						content: "What's the architecture?",
					},
					{ id: "a1", role: "assistant", content: "Here are…" },
				],
				parentConversationId: null,
			},
		]);
		dbMock.user.findMany.mockResolvedValue([
			{ id: "user-1", name: "Alice", image: "https://example.com/a.png" },
		]);

		const result = await handlers.listForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
				limit: 10,
			},
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			conversationId: "conv-a",
			title: "Drafting kickoff",
			messageCount: 2,
			firstPromptPreview: "What's the architecture?",
			authorId: "user-1",
			authorName: "Alice",
			authorAvatarUrl: "https://example.com/a.png",
			visibility: "PRIVATE",
		});
		expect(result.nextCursor).toBe("cursor-xyz");
	});

	it("returns nullable shapes when the joined conversation row is missing", async () => {
		repoDatabaseMock.listDocumentAssistantConversations.mockResolvedValue({
			items: [sampleRow("b", "user-2", "SHARED")],
			nextCursor: null,
		});
		dbMock.agentConversation.findMany.mockResolvedValue([]);
		dbMock.user.findMany.mockResolvedValue([]);

		const result = await handlers.listForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
				limit: 10,
			},
		});

		expect(result.items[0]).toMatchObject({
			messageCount: 0,
			firstPromptPreview: null,
			authorName: null,
			authorAvatarUrl: null,
		});
	});
});

describe("listForDocument — cursor pagination plumb-through", () => {
	it("forwards cursor + limit to the helper", async () => {
		repoDatabaseMock.listDocumentAssistantConversations.mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		await handlers.listForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
				cursor: "opaque-cursor",
				limit: 25,
			},
		});

		expect(
			repoDatabaseMock.listDocumentAssistantConversations,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				cursor: "opaque-cursor",
				limit: 25,
			}),
		);
	});
});

/**
 * `getActiveForDocument` — SSR hydration loader.
 *
 * Spec acceptance criteria covered:
 *   - §5.2 returns most-recent ACTIVE row owned by the caller, OR null.
 *   - FR-27 / AC-15 feature flag OFF returns `{ conversation: null }`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dbMock,
	handlers,
	makeContext,
	repoDatabaseMock,
	setPendingHandlerKey,
} from "./_harness";

setPendingHandlerKey("getActiveForDocument");
await import("../get-active-for-document");

interface BuiltContext {
	user: { id: string; email: string; name: string };
	session: { id: string; activeOrganizationId: string };
	headers: Headers;
}

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.organization.findUnique.mockResolvedValue({
		documentAssistantHistoryEnabled: true,
	});
});

describe("getActiveForDocument", () => {
	it("returns { conversation: null } when no active row exists", async () => {
		repoDatabaseMock.getActiveDocumentAssistantConversation.mockResolvedValue(
			null,
		);

		const result = await handlers.getActiveForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
			},
		});

		expect(result).toEqual({ conversation: null });
	});

	it("returns the row shape including messages + parent linkage", async () => {
		repoDatabaseMock.getActiveDocumentAssistantConversation.mockResolvedValue(
			{
				id: "join-1",
				conversationId: "conv-1",
				visibility: "PRIVATE",
				visibilityLockedAt: new Date("2026-05-19T09:00:00Z"),
				createdAt: new Date("2026-05-19T08:00:00Z"),
				updatedAt: new Date("2026-05-19T09:30:00Z"),
				conversation: {
					title: "Reviewing PRD",
					agentId: "doc-agent",
					messages: [
						{ id: "u1", role: "user", content: "let's review" },
					],
					parentConversationId: "conv-prev",
				},
			},
		);

		const result = await handlers.getActiveForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
			},
		});

		expect(result.conversation).toMatchObject({
			conversationId: "conv-1",
			title: "Reviewing PRD",
			visibility: "PRIVATE",
			parentConversationId: "conv-prev",
		});
		expect((result.conversation?.messages ?? []).length).toBe(1);
	});

	it("returns { conversation: null } when org feature flag is OFF", async () => {
		dbMock.organization.findUnique.mockResolvedValue({
			documentAssistantHistoryEnabled: false,
		});

		const result = await handlers.getActiveForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
			},
		});

		expect(result).toEqual({ conversation: null });
		expect(
			repoDatabaseMock.getActiveDocumentAssistantConversation,
		).not.toHaveBeenCalled();
	});

	it("passes personal-context tenantFilter when organizationId is null", async () => {
		repoDatabaseMock.getActiveDocumentAssistantConversation.mockResolvedValue(
			null,
		);

		await handlers.getActiveForDocument({
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
			},
		});

		expect(
			repoDatabaseMock.getActiveDocumentAssistantConversation,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				tenantFilter: { organizationId: null, userId: "user-1" },
			}),
		);
	});
});

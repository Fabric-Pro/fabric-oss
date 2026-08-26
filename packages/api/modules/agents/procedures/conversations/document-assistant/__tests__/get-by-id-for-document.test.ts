/**
 * `getByIdForDocument` — Group F.13 hotfix.
 *
 * Spec acceptance criteria covered:
 *   - §3.4 FR-12 / FR-14 a non-active conversation can be loaded into the
 *     drawer's read-only viewer.
 *   - §3.5 FR-19 visibility predicate (SHARED + own PRIVATE) applied at the
 *     query level, not in the procedure body.
 *   - §9.3 / AC-11 every miss (cross-tenant, wrong document, private+
 *     non-author, deleted) collapses into `{ conversation: null }` so the
 *     FORBIDDEN/NOT_FOUND distinction can't leak existence.
 *   - §3.11 FR-27 / AC-15 feature flag OFF short-circuits to `null` BEFORE
 *     touching the helper.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dbMock,
	handlers,
	makeContext,
	repoDatabaseMock,
	setPendingHandlerKey,
} from "./_harness";

setPendingHandlerKey("getByIdForDocument");
await import("../get-by-id-for-document");

interface BuiltContext {
	user: { id: string; email: string; name: string };
	session: { id: string; activeOrganizationId: string };
	headers: Headers;
}

const baseInput = {
	conversationId: "conv-1",
	documentRefKind: "PROJECT_DOCUMENT" as const,
	documentRefId: "doc-1",
	projectId: "proj-1",
	organizationId: "org-1",
};

function makeHelperResult(
	overrides: {
		userId?: string;
		visibility?: "SHARED" | "PRIVATE";
		archivedAt?: Date | null;
		title?: string | null;
		messages?: unknown[];
		parentConversationId?: string | null;
	} = {},
) {
	return {
		joinRow: {
			id: "join-1",
			conversationId: "conv-1",
			documentRefKind: "PROJECT_DOCUMENT" as const,
			documentRefId: "doc-1",
			projectId: "proj-1",
			organizationId: "org-1",
			userId: overrides.userId ?? "user-1",
			visibility: overrides.visibility ?? "PRIVATE",
			visibilityLockedAt: new Date("2026-05-19T09:00:00Z"),
			archivedAt: overrides.archivedAt ?? null,
			createdAt: new Date("2026-05-19T08:00:00Z"),
			updatedAt: new Date("2026-05-19T09:30:00Z"),
		},
		agentConversation: {
			id: "conv-1",
			title: overrides.title ?? "Earlier conversation",
			agentId: "doc-agent",
			messages: overrides.messages ?? [
				{ id: "u1", role: "user", content: "Earlier prompt" },
				{
					id: "a1",
					role: "assistant",
					content: "Earlier reply",
				},
			],
			parentConversationId: overrides.parentConversationId ?? null,
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.organization.findUnique.mockResolvedValue({
		documentAssistantHistoryEnabled: true,
	});
});

describe("getByIdForDocument — happy paths", () => {
	it("returns the conversation when caller is author + visibility PRIVATE", async () => {
		repoDatabaseMock.getDocumentAssistantConversationByIdAndDocument.mockResolvedValue(
			makeHelperResult({ userId: "user-1", visibility: "PRIVATE" }),
		);

		const result = await handlers.getByIdForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: baseInput,
		});

		expect(result.conversation).toMatchObject({
			conversationId: "conv-1",
			title: "Earlier conversation",
			visibility: "PRIVATE",
		});
		expect((result.conversation?.messages ?? []).length).toBe(2);
		// Sanity: the helper received the visibility-predicate args.
		expect(
			repoDatabaseMock.getDocumentAssistantConversationByIdAndDocument,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conv-1",
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				currentUserId: "user-1",
				tenantFilter: { organizationId: "org-1", userId: "user-1" },
			}),
		);
	});

	it("returns the conversation when visibility is SHARED + caller is another project member", async () => {
		// Caller is user-1; the conversation belongs to user-99 with SHARED
		// visibility. The helper would let it through because of the SHARED
		// branch in the OR predicate; here we assert the procedure just
		// passes the resulting row through unchanged.
		repoDatabaseMock.getDocumentAssistantConversationByIdAndDocument.mockResolvedValue(
			makeHelperResult({ userId: "user-99", visibility: "SHARED" }),
		);

		const result = await handlers.getByIdForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: baseInput,
		});

		expect(result.conversation).toMatchObject({
			conversationId: "conv-1",
			visibility: "SHARED",
		});
	});

	it("personal context: feature-flag lookup is skipped and helper is called with personal tenantFilter", async () => {
		repoDatabaseMock.getDocumentAssistantConversationByIdAndDocument.mockResolvedValue(
			makeHelperResult(),
		);

		await handlers.getByIdForDocument({
			context: makeContext({
				session: {
					id: "sess-1",
					activeOrganizationId: null as unknown as string,
					impersonatedBy: null,
				} as unknown as never,
			}) as unknown as BuiltContext,
			input: { ...baseInput, organizationId: null },
		});

		expect(dbMock.organization.findUnique).not.toHaveBeenCalled();
		expect(
			repoDatabaseMock.getDocumentAssistantConversationByIdAndDocument,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				tenantFilter: { organizationId: null, userId: "user-1" },
			}),
		);
	});
});

describe("getByIdForDocument — null branches (info-leak avoidance)", () => {
	it("returns null (NOT NOT_FOUND) when the conversation is PRIVATE and caller is not the author", async () => {
		// The DB helper applies the visibility predicate; from the procedure's
		// vantage point the row simply doesn't exist for this caller.
		repoDatabaseMock.getDocumentAssistantConversationByIdAndDocument.mockResolvedValue(
			null,
		);

		const result = await handlers.getByIdForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: baseInput,
		});

		expect(result).toEqual({ conversation: null });
	});

	it("returns null when (documentRefKind, documentRefId) doesn't match", async () => {
		repoDatabaseMock.getDocumentAssistantConversationByIdAndDocument.mockResolvedValue(
			null,
		);

		const result = await handlers.getByIdForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: {
				...baseInput,
				documentRefKind: "USER_STORY",
				documentRefId: "story-42",
			},
		});

		expect(result).toEqual({ conversation: null });
	});

	it("returns null when the XOR tenant context mismatches the row", async () => {
		// Personal-context caller, org-context row. The DB helper's
		// `buildTenantWhere` already returns no rows; the procedure passes
		// the helper's null straight through.
		repoDatabaseMock.getDocumentAssistantConversationByIdAndDocument.mockResolvedValue(
			null,
		);

		const result = await handlers.getByIdForDocument({
			context: makeContext({
				session: {
					id: "sess-1",
					activeOrganizationId: null as unknown as string,
					impersonatedBy: null,
				} as unknown as never,
			}) as unknown as BuiltContext,
			input: { ...baseInput, organizationId: null },
		});

		expect(result).toEqual({ conversation: null });
	});
});

describe("getByIdForDocument — feature flag", () => {
	it("returns null when the org has documentAssistantHistoryEnabled = false", async () => {
		dbMock.organization.findUnique.mockResolvedValue({
			documentAssistantHistoryEnabled: false,
		});

		const result = await handlers.getByIdForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: baseInput,
		});

		expect(result).toEqual({ conversation: null });
		expect(
			repoDatabaseMock.getDocumentAssistantConversationByIdAndDocument,
		).not.toHaveBeenCalled();
	});
});

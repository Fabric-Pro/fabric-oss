/**
 * `setVisibilityForDocument` — author-only flip with lock invariant.
 *
 * Spec acceptance criteria covered:
 *   - §5.4 / FR-17–FR-19 author-only.
 *   - AC-8: returns CONFLICT once locked.
 *   - §3.6 FR-21 / AC-10: emits `visibility_changed` with { from, to }.
 *   - §3.11 FR-27 / AC-15: write returns CONFLICT when org flag is OFF.
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

setPendingHandlerKey("setVisibilityForDocument");
await import("../set-visibility-for-document");

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

const baseInput = {
	conversationId: "conv-1",
	organizationId: "org-1",
	visibility: "PRIVATE" as const,
};

describe("setVisibilityForDocument — happy path", () => {
	it("flips visibility and emits the visibility_changed audit", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			visibility: "SHARED",
		});
		repoDatabaseMock.setDocumentAssistantConversationVisibility.mockResolvedValue(
			{
				id: "join-1",
				visibility: "PRIVATE",
				visibilityLockedAt: null,
			},
		);

		const result = await handlers.setVisibilityForDocument({
			context: makeContext() as unknown as BuiltContext,
			input: baseInput,
		});

		expect(result.conversation).toMatchObject({
			id: "join-1",
			visibility: "PRIVATE",
			visibilityLockedAt: null,
		});
		expect(recordAuditMock).toHaveBeenCalledTimes(1);
		const [, payload] = recordAuditMock.mock.calls[0] as [
			unknown,
			{ action: string; metadata: Record<string, unknown> },
		];
		expect(payload.action).toBe(
			"document_assistant.conversation.visibility_changed",
		);
		expect(payload.metadata).toMatchObject({
			from: "SHARED",
			to: "PRIVATE",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
		});
	});

	it("does NOT emit an audit when the visibility is unchanged", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			visibility: "PRIVATE",
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
			input: baseInput,
		});

		expect(recordAuditMock).not.toHaveBeenCalled();
	});
});

describe("setVisibilityForDocument — guard rails", () => {
	it("returns CONFLICT once visibilityLockedAt is set", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			visibility: "SHARED",
		});
		repoDatabaseMock.setDocumentAssistantConversationVisibility.mockImplementation(
			() => {
				throw new repoDatabaseMock.DocumentAssistantVisibilityLockedError(
					"join-1",
				);
			},
		);

		await expect(
			handlers.setVisibilityForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: baseInput,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("locked"),
		});
		expect(recordAuditMock).not.toHaveBeenCalled();
	});

	it("returns FORBIDDEN for a non-author", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "other-user",
			organizationId: "org-1",
			projectId: "proj-1",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			visibility: "SHARED",
		});

		await expect(
			handlers.setVisibilityForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: baseInput,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			repoDatabaseMock.setDocumentAssistantConversationVisibility,
		).not.toHaveBeenCalled();
		expect(recordAuditMock).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND on cross-tenant attempts (no info leak)", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "user-1",
			organizationId: "other-org",
			projectId: "proj-1",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			visibility: "SHARED",
		});

		await expect(
			handlers.setVisibilityForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: baseInput,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(recordAuditMock).not.toHaveBeenCalled();
	});

	it("returns CONFLICT when the org feature flag is OFF", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			visibility: "SHARED",
		});
		dbMock.organization.findUnique.mockResolvedValue({
			documentAssistantHistoryEnabled: false,
		});

		await expect(
			handlers.setVisibilityForDocument({
				context: makeContext() as unknown as BuiltContext,
				input: baseInput,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("disabled"),
		});
		expect(
			repoDatabaseMock.setDocumentAssistantConversationVisibility,
		).not.toHaveBeenCalled();
	});
});

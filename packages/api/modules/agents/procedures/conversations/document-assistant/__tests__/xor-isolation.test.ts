/**
 * Tenant XOR isolation regression — spec §3.5 FR-20, §9.3, AC-11.
 *
 * Each write procedure must return NOT_FOUND (not FORBIDDEN) when the
 * targeted conversation lives in a different tenant than the caller.
 * NOT_FOUND avoids leaking the existence of org rows to personal-
 * context callers (and vice versa).
 *
 * Read procedures use the query helper, whose tenantFilter already does
 * the XOR — those are covered indirectly by list-for-document.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dbMock,
	handlers,
	makeContext,
	setPendingHandlerKey,
} from "./_harness";

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

setPendingHandlerKey("recordDiffOutcome");
await import("../record-diff-outcome");

interface BuiltContext {
	user: { id: string; email: string; name: string };
	session: { id: string; activeOrganizationId: string };
	headers: Headers;
}

const orgRow = {
	id: "join-1",
	userId: "user-1",
	organizationId: "org-A",
	projectId: "proj-1",
	documentRefKind: "PROJECT_DOCUMENT" as const,
	documentRefId: "doc-1",
	visibility: "SHARED" as const,
	conversation: { id: "conv-1", title: "Title", messages: [] },
};

const personalRow = {
	id: "join-2",
	userId: "user-1",
	organizationId: null,
	projectId: "proj-1",
	documentRefKind: "PROJECT_DOCUMENT" as const,
	documentRefId: "doc-1",
	visibility: "SHARED" as const,
	conversation: { id: "conv-2", title: "Title", messages: [] },
};

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.organization.findUnique.mockResolvedValue({
		documentAssistantHistoryEnabled: true,
	});
});

describe("XOR isolation — personal caller cannot reach an org row", () => {
	const callerContext = makeContext({
		session: {
			id: "sess-1",
			activeOrganizationId: null as unknown as string,
			impersonatedBy: null,
		} as unknown as never,
	}) as unknown as BuiltContext;

	it("appendTurnForDocument → NOT_FOUND", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			orgRow,
		);
		await expect(
			handlers.appendTurnForDocument({
				context: callerContext,
				input: {
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: "doc-1",
					projectId: "proj-1",
					organizationId: null,
					conversationId: "conv-1",
					agentId: "doc-agent",
					message: {
						id: "msg-x",
						role: "user",
						content: "hi",
						timestamp: "2026-05-19T10:00:00.000Z",
					},
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("setVisibilityForDocument → NOT_FOUND", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			orgRow,
		);
		await expect(
			handlers.setVisibilityForDocument({
				context: callerContext,
				input: {
					conversationId: "conv-1",
					organizationId: null,
					visibility: "PRIVATE",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("archiveForDocument → NOT_FOUND", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			orgRow,
		);
		await expect(
			handlers.archiveForDocument({
				context: callerContext,
				input: { conversationId: "conv-1", organizationId: null },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("deleteForDocument → NOT_FOUND", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			orgRow,
		);
		await expect(
			handlers.deleteForDocument({
				context: callerContext,
				input: { conversationId: "conv-1", organizationId: null },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("renameForDocument → NOT_FOUND", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			orgRow,
		);
		await expect(
			handlers.renameForDocument({
				context: callerContext,
				input: {
					conversationId: "conv-1",
					organizationId: null,
					title: "Hijack",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("recordDiffOutcome → NOT_FOUND", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			orgRow,
		);
		await expect(
			handlers.recordDiffOutcome({
				context: callerContext,
				input: {
					conversationId: "conv-1",
					projectId: "proj-1",
					organizationId: null,
					messageId: "msg-1",
					toolCallId: "tc-1",
					outcome: "accepted",
					at: "2026-05-19T10:00:00.000Z",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("XOR isolation — org caller cannot reach a personal row", () => {
	const callerContext = makeContext() as unknown as BuiltContext;

	it("appendTurnForDocument → NOT_FOUND", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			personalRow,
		);
		await expect(
			handlers.appendTurnForDocument({
				context: callerContext,
				input: {
					documentRefKind: "PROJECT_DOCUMENT",
					documentRefId: "doc-1",
					projectId: "proj-1",
					organizationId: "org-A",
					conversationId: "conv-2",
					agentId: "doc-agent",
					message: {
						id: "msg-x",
						role: "user",
						content: "hi",
						timestamp: "2026-05-19T10:00:00.000Z",
					},
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("renameForDocument → NOT_FOUND", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue(
			personalRow,
		);
		await expect(
			handlers.renameForDocument({
				context: callerContext,
				input: {
					conversationId: "conv-2",
					organizationId: "org-A",
					title: "Hijack",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

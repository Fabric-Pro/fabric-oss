/**
 * `recordDiffOutcome` — patches the messages JSON to stamp
 * acceptedAt / rejectedAt on the targeted tool-call. Spec §5.8.
 *
 * Asserts:
 *   - Author + project members with PROJECT_UPDATE can record (the
 *     permission gate is delegated to `requireProjectPermission`, which
 *     the harness stubs to a no-op; the procedure itself only checks
 *     tenant scope + project scope).
 *   - Cross-project conversationId returns NOT_FOUND.
 *   - Cross-tenant conversationId returns NOT_FOUND.
 *   - Unknown tool-call returns NOT_FOUND.
 *   - A caller who cannot see the thread's document's project, or a
 *     thread whose document is in another project, is NOT_FOUND and
 *     nothing is written.
 *   - Stamps the correct tool-call by (messageId, toolCallId) and
 *     preserves every other tool call intact.
 *   - Does NOT emit an audit event (per spec §5.8).
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

setPendingHandlerKey("recordDiffOutcome");
await import("../record-diff-outcome");

interface BuiltContext {
	user: { id: string; email: string; name: string };
	session: { id: string; activeOrganizationId: string };
	headers: Headers;
}

const messages = [
	{
		id: "msg-1",
		role: "assistant",
		content: "edit proposal",
		toolCalls: [
			{ id: "tc-a", name: "write_document_local", args: { path: "/a" } },
			{ id: "tc-b", name: "write_document_local", args: { path: "/b" } },
		],
	},
	{
		id: "msg-2",
		role: "assistant",
		content: "another",
		toolCalls: [
			{ id: "tc-c", name: "write_document_local", args: { path: "/c" } },
		],
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	repoDatabaseMock.getDocumentRefProjectId.mockResolvedValue("proj-1");
	repoDatabaseMock.hasProjectAccess.mockResolvedValue(true);
});

describe("recordDiffOutcome — happy path", () => {
	it("stamps acceptedAt on the targeted tool-call only", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			conversation: { id: "conv-1", messages },
		});

		const result = await handlers.recordDiffOutcome({
			context: makeContext() as unknown as BuiltContext,
			input: {
				conversationId: "conv-1",
				projectId: "proj-1",
				organizationId: "org-1",
				messageId: "msg-1",
				toolCallId: "tc-b",
				outcome: "accepted",
				at: "2026-05-19T10:00:00.000Z",
			},
		});

		expect(result).toEqual({ success: true });
		const updateCall = dbMock.agentConversation.update.mock.calls[0]?.[0];
		const persisted = updateCall.data.messages as typeof messages;
		// Untouched tool calls are returned by reference — no acceptedAt
		// field gets attached unless they were the target.
		expect(persisted[0]!.toolCalls?.[0]).toEqual(
			messages[0]!.toolCalls![0],
		);
		expect(persisted[0]!.toolCalls?.[1]).toMatchObject({
			id: "tc-b",
			acceptedAt: "2026-05-19T10:00:00.000Z",
		});
		expect(persisted[1]!.toolCalls?.[0]).toEqual(
			messages[1]!.toolCalls![0],
		);
		expect(recordAuditMock).not.toHaveBeenCalled();
	});

	it("stamps rejectedAt instead when outcome is 'rejected'", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			conversation: { id: "conv-1", messages },
		});

		await handlers.recordDiffOutcome({
			context: makeContext() as unknown as BuiltContext,
			input: {
				conversationId: "conv-1",
				projectId: "proj-1",
				organizationId: "org-1",
				messageId: "msg-2",
				toolCallId: "tc-c",
				outcome: "rejected",
				at: "2026-05-19T10:30:00.000Z",
			},
		});

		const updateCall = dbMock.agentConversation.update.mock.calls[0]?.[0];
		const persisted = updateCall.data.messages as typeof messages;
		expect(persisted[1]!.toolCalls?.[0]).toMatchObject({
			id: "tc-c",
			rejectedAt: "2026-05-19T10:30:00.000Z",
		});
	});
});

describe("recordDiffOutcome — guard rails", () => {
	it("returns NOT_FOUND when conversation belongs to another project", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "other-proj",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			conversation: { id: "conv-1", messages },
		});

		await expect(
			handlers.recordDiffOutcome({
				context: makeContext() as unknown as BuiltContext,
				input: {
					conversationId: "conv-1",
					projectId: "proj-1",
					organizationId: "org-1",
					messageId: "msg-1",
					toolCallId: "tc-a",
					outcome: "accepted",
					at: "2026-05-19T10:00:00.000Z",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dbMock.agentConversation.update).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND on cross-tenant lookup", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "user-1",
			organizationId: "other-org",
			projectId: "proj-1",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			conversation: { id: "conv-1", messages },
		});

		await expect(
			handlers.recordDiffOutcome({
				context: makeContext() as unknown as BuiltContext,
				input: {
					conversationId: "conv-1",
					projectId: "proj-1",
					organizationId: "org-1",
					messageId: "msg-1",
					toolCallId: "tc-a",
					outcome: "accepted",
					at: "2026-05-19T10:00:00.000Z",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("returns NOT_FOUND when the targeted tool-call doesn't exist", async () => {
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-1",
			conversation: { id: "conv-1", messages },
		});

		await expect(
			handlers.recordDiffOutcome({
				context: makeContext() as unknown as BuiltContext,
				input: {
					conversationId: "conv-1",
					projectId: "proj-1",
					organizationId: "org-1",
					messageId: "msg-1",
					toolCallId: "tc-zzz",
					outcome: "accepted",
					at: "2026-05-19T10:00:00.000Z",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dbMock.agentConversation.update).not.toHaveBeenCalled();
	});
});

describe("recordDiffOutcome — the document's project", () => {
	const input = {
		conversationId: "conv-1",
		projectId: "proj-1",
		organizationId: "org-1",
		messageId: "msg-1",
		toolCallId: "tc-a",
		outcome: "accepted" as const,
		at: "2026-05-19T10:00:00.000Z",
	};

	beforeEach(() => {
		// Another member's thread on a document in the named project.
		dbMock.documentAssistantConversation.findUnique.mockResolvedValue({
			id: "join-1",
			userId: "user-99",
			organizationId: "org-1",
			projectId: "proj-1",
			documentRefKind: "USER_STORY",
			documentRefId: "story-1",
			conversation: { id: "conv-1", messages },
		});
	});

	it("refuses a member who cannot see the project, writing nothing", async () => {
		repoDatabaseMock.hasProjectAccess.mockResolvedValue(false);

		await expect(
			handlers.recordDiffOutcome({
				context: makeContext() as unknown as BuiltContext,
				input,
			}),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		// Checked against the thread's own document, since the input names none.
		expect(repoDatabaseMock.getDocumentRefProjectId).toHaveBeenCalledWith({
			documentRefKind: "USER_STORY",
			documentRefId: "story-1",
		});
		expect(repoDatabaseMock.hasProjectAccess).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
		);
		expect(dbMock.agentConversation.update).not.toHaveBeenCalled();
	});

	it("refuses a thread whose document is in another project, writing nothing", async () => {
		repoDatabaseMock.getDocumentRefProjectId.mockResolvedValue(
			"proj-other",
		);

		await expect(
			handlers.recordDiffOutcome({
				context: makeContext() as unknown as BuiltContext,
				input,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(repoDatabaseMock.hasProjectAccess).not.toHaveBeenCalled();
		expect(dbMock.agentConversation.update).not.toHaveBeenCalled();
	});

	it("records the outcome for a member who can see the project", async () => {
		await expect(
			handlers.recordDiffOutcome({
				context: makeContext() as unknown as BuiltContext,
				input,
			}),
		).resolves.toEqual({ success: true });
		expect(dbMock.agentConversation.update).toHaveBeenCalledTimes(1);
	});
});

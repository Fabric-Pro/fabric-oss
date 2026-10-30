/**
 * The document's project, on every read of a document's threads and every
 * write that starts one.
 *
 * Organization membership alone let a member who is not on the project read
 * the SHARED threads of its documents, and start threads there that its
 * members would then read. Each procedure now asks `hasProjectAccess` of the
 * project the document belongs to (read off the document, never the input),
 * and refuses a document outside the named project:
 *
 *  - a member without access to the project is refused NOT_FOUND, in a
 *    missing project's words, and nothing is read or written;
 *  - a member with access goes on as before, SHARED threads included;
 *  - a project guest is still refused by organization membership on the
 *    reads, before the project is looked at.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dbMock,
	handlers,
	makeContext,
	repoDatabaseMock,
	setPendingHandlerKey,
} from "./_harness";

// After the harness, so this is its mock.
const { verifyOrganizationMembership } = await import(
	"../../../../../organizations/lib/membership"
);

setPendingHandlerKey("listForDocument");
await import("../list-for-document");
setPendingHandlerKey("getActiveForDocument");
await import("../get-active-for-document");
setPendingHandlerKey("getByIdForDocument");
await import("../get-by-id-for-document");
setPendingHandlerKey("appendTurnForDocument");
await import("../append-turn-for-document");
setPendingHandlerKey("forkForDocument");
await import("../fork-for-document");

const documentRef = {
	documentRefKind: "PROJECT_DOCUMENT" as const,
	documentRefId: "doc-1",
	projectId: "proj-1",
	organizationId: "org-1",
};

const sharedRow = {
	id: "join-1",
	conversationId: "conv-1",
	documentRefKind: "PROJECT_DOCUMENT" as const,
	documentRefId: "doc-1",
	projectId: "proj-1",
	organizationId: "org-1",
	// Another member's thread, shared with the project.
	userId: "user-99",
	visibility: "SHARED" as const,
	visibilityLockedAt: new Date("2026-10-29T09:00:00Z"),
	archivedAt: null,
	createdAt: new Date("2026-10-29T08:00:00Z"),
	updatedAt: new Date("2026-10-29T09:30:00Z"),
};

const conversation = {
	id: "conv-1",
	title: "Pricing questions",
	agentId: "doc-agent",
	messages: [{ id: "u1", role: "user", content: "What does it cost?" }],
	parentConversationId: null,
};

const message = {
	id: "msg-1",
	role: "user" as const,
	content: "Tighten the scope section",
	timestamp: "2026-10-30T09:00:00Z",
};

/** Each procedure, with an input naming `documentRef`. */
const reads = {
	listForDocument: () => ({ ...documentRef, limit: 10 }),
	getActiveForDocument: () => ({ ...documentRef }),
	getByIdForDocument: () => ({ ...documentRef, conversationId: "conv-1" }),
} as const;

const writes = {
	appendTurnForDocument: () => ({
		...documentRef,
		message,
		agentId: "doc-agent",
	}),
	forkForDocument: () => ({
		...documentRef,
		sourceConversationId: "conv-own",
	}),
} as const;

type ProcedureName = keyof typeof reads | keyof typeof writes;

function inputFor(name: ProcedureName): Record<string, unknown> {
	return name in reads
		? reads[name as keyof typeof reads]()
		: writes[name as keyof typeof writes]();
}

function run(name: ProcedureName, context = makeContext()) {
	return handlers[name]({ input: inputFor(name), context });
}

async function refusal(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		return error as { code?: string; message?: string };
	}
	throw new Error("expected the call to be refused");
}

/** Every read or write of thread data a procedure could have made. */
function expectNothingTouched() {
	expect(
		repoDatabaseMock.listDocumentAssistantConversations,
	).not.toHaveBeenCalled();
	expect(
		repoDatabaseMock.getActiveDocumentAssistantConversation,
	).not.toHaveBeenCalled();
	expect(
		repoDatabaseMock.getDocumentAssistantConversationByIdAndDocument,
	).not.toHaveBeenCalled();
	expect(
		repoDatabaseMock.createDocumentAssistantConversation,
	).not.toHaveBeenCalled();
	expect(dbMock.$transaction).not.toHaveBeenCalled();
	expect(dbMock.organization.findUnique).not.toHaveBeenCalled();
}

const ALL = [...Object.keys(reads), ...Object.keys(writes)] as ProcedureName[];

beforeEach(() => {
	vi.clearAllMocks();
	repoDatabaseMock.getDocumentRefProjectId.mockResolvedValue("proj-1");
	repoDatabaseMock.hasProjectAccess.mockResolvedValue(true);
	dbMock.organization.findUnique.mockResolvedValue({
		documentAssistantHistoryEnabled: true,
	});
});

describe("a member who cannot see the document's project", () => {
	it.each(ALL)(
		"is refused by %s, and nothing is read or written",
		async (name) => {
			repoDatabaseMock.hasProjectAccess.mockResolvedValue(false);

			const error = await refusal(run(name));

			expect(error.code).toBe("NOT_FOUND");
			expect(error.message).toBe("Project not found");
			expect(
				repoDatabaseMock.getDocumentRefProjectId,
			).toHaveBeenCalledWith({
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
			});
			expect(repoDatabaseMock.hasProjectAccess).toHaveBeenCalledWith(
				"proj-1",
				"user-1",
			);
			expectNothingTouched();
		},
	);
});

describe("a document outside the named project", () => {
	it.each(ALL)(
		"is refused by %s even when the named project is reachable",
		async (name) => {
			repoDatabaseMock.getDocumentRefProjectId.mockResolvedValue(
				"proj-other",
			);

			const error = await refusal(run(name));

			expect(error.code).toBe("NOT_FOUND");
			expect(error.message).toBe("Project not found");
			// The reachable project named in the input vouches for nothing.
			expect(repoDatabaseMock.hasProjectAccess).not.toHaveBeenCalled();
			expectNothingTouched();
		},
	);

	it.each(ALL)(
		"is refused by %s when no document has the ref",
		async (name) => {
			repoDatabaseMock.getDocumentRefProjectId.mockResolvedValue(null);

			const error = await refusal(run(name));

			expect(error.code).toBe("NOT_FOUND");
			expectNothingTouched();
		},
	);
});

describe("a member who can see the document's project", () => {
	it("lists another member's SHARED thread", async () => {
		repoDatabaseMock.listDocumentAssistantConversations.mockResolvedValue({
			items: [sharedRow],
			nextCursor: null,
		});
		dbMock.agentConversation.findMany.mockResolvedValue([conversation]);
		dbMock.user.findMany.mockResolvedValue([
			{ id: "user-99", name: "Bea", image: null },
		]);

		const result = (await run("listForDocument")) as {
			items: { conversationId: string; visibility: string }[];
		};

		expect(result.items).toEqual([
			expect.objectContaining({
				conversationId: "conv-1",
				visibility: "SHARED",
			}),
		]);
		expect(repoDatabaseMock.hasProjectAccess).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
		);
	});

	it("reads another member's SHARED thread by id", async () => {
		repoDatabaseMock.getDocumentAssistantConversationByIdAndDocument.mockResolvedValue(
			{ joinRow: sharedRow, agentConversation: conversation },
		);

		const result = (await run("getByIdForDocument")) as {
			conversation: {
				conversationId: string;
				messages: unknown[];
			} | null;
		};

		expect(result.conversation).toMatchObject({
			conversationId: "conv-1",
			messages: conversation.messages,
		});
	});

	it("reads their own active thread", async () => {
		repoDatabaseMock.getActiveDocumentAssistantConversation.mockResolvedValue(
			{ ...sharedRow, userId: "user-1", conversation },
		);

		const result = (await run("getActiveForDocument")) as {
			conversation: { conversationId: string } | null;
		};

		expect(result.conversation).toMatchObject({ conversationId: "conv-1" });
	});

	it.each(Object.keys(writes) as ProcedureName[])(
		"goes on past the check in %s, to the history gate",
		async (name) => {
			// The history gate is the next step; turned off, it answers
			// CONFLICT, which shows the project check let the call through.
			dbMock.organization.findUnique.mockResolvedValue({
				documentAssistantHistoryEnabled: false,
			});

			const error = await refusal(run(name));

			expect(error.code).toBe("CONFLICT");
			expect(repoDatabaseMock.hasProjectAccess).toHaveBeenCalledWith(
				"proj-1",
				"user-1",
			);
		},
	);
});

describe("a project guest", () => {
	it.each(Object.keys(reads) as ProcedureName[])(
		"is still refused by %s for not being an organization member, before the project is looked at",
		async (name) => {
			// A guest has an accepted ProjectMember row, so `hasProjectAccess`
			// would let them in; membership refuses them first, as before.
			vi.mocked(verifyOrganizationMembership).mockResolvedValueOnce(null);

			const error = await refusal(run(name));

			expect(error.code).toBe("FORBIDDEN");
			expect(
				repoDatabaseMock.getDocumentRefProjectId,
			).not.toHaveBeenCalled();
			expectNothingTouched();
		},
	);
});

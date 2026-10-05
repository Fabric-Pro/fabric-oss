/**
 * `updateDocumentProcedure` and the way out of DRAFT.
 *
 * A document written by hand used to stay a draft for good: no save completed
 * it, and nothing in the product sent a status. `completeDraft` is the author
 * saying the document is finished — the editor's explicit Save, or the list's
 * Mark as complete. An autosave does not send it.
 *
 * Pinned here:
 *   - the procedure completes only a draft with content, through the guarded
 *     `completeDraftDocument` write, and never on its own;
 *   - what it reports and does afterwards follows that write's own result,
 *     not a comparison of two reads taken at different times — so a document
 *     someone else completed is not claimed, embedded or announced by this
 *     request;
 *   - a document that has just become COMPLETE is handed to the embed even
 *     when the update carried no content.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockHasProjectAccess,
	mockUpdateDocument,
	mockCompleteDraftDocument,
	mockApplySideEffects,
	mockProjectDocumentFindUnique,
	mockFanOutDocumentMention,
	mockFanOutSubscriptionUpdate,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockHasProjectAccess: vi.fn(),
	mockUpdateDocument: vi.fn(),
	mockCompleteDraftDocument: vi.fn(),
	mockApplySideEffects: vi.fn(),
	mockProjectDocumentFindUnique: vi.fn(),
	mockFanOutDocumentMention: vi.fn(),
	mockFanOutSubscriptionUpdate: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
	completeDraftDocument: (...args: unknown[]) =>
		mockCompleteDraftDocument(...args),
	buildDocumentLink: (args: { projectId: string; documentId: string }) =>
		`projects/${args.projectId}/documents/${args.documentId}`,
	db: {
		projectDocument: {
			findUnique: (...args: unknown[]) =>
				mockProjectDocumentFindUnique(...args),
		},
	},
}));

vi.mock("@repo/database/prisma/zod", () => ({
	ProjectDocumentStatusSchema: {
		optional: () => ({}),
	},
}));

vi.mock("../../../../lib/document-side-effects", () => ({
	applyDocumentUpdateSideEffects: (...args: unknown[]) =>
		mockApplySideEffects(...args),
}));

vi.mock("../../../../lib/notification-service", () => ({
	fanOut: {
		documentMention: (...args: unknown[]) =>
			mockFanOutDocumentMention(...args),
		subscriptionUpdate: (...args: unknown[]) =>
			mockFanOutSubscriptionUpdate(...args),
	},
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateDocument = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

// Side-effect: register the handler.
import "../update-document";

const ctx = {
	user: { id: "actor_1", name: "Alice" },
	session: { id: "session-1", activeOrganizationId: "org_1" },
};

const baseInput = {
	projectId: "proj_1",
	id: "doc_1",
	organizationId: "org_1",
};

const BODY = "# Design\n\nWritten by hand.";

/** The document as the procedure reads it before the write. */
function priorDocument(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "proj_1",
		content: BODY,
		title: "Design notes",
		status: "DRAFT",
		type: "TECHNICAL_SPEC",
		version: 2,
		...overrides,
	};
}

/** The row the save returns: a draft with content unless a test says otherwise. */
function savedDocument(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc_1",
		title: "Design notes",
		type: "TECHNICAL_SPEC",
		content: BODY,
		status: "DRAFT",
		version: 2,
		...overrides,
	};
}

async function flushPromises() {
	// Let the fire-and-forget fan-out dispatches settle so they never leak into
	// a later test.
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

type UpdateResult = {
	document: { status: string };
	draftCompleted: boolean;
};

async function update(input: Record<string, unknown>): Promise<UpdateResult> {
	const result = (await handlers.updateDocument({
		input: { ...baseInput, ...input },
		context: ctx,
	})) as UpdateResult;
	await flushPromises();
	return result;
}

/** The `skipEmbed` the one side-effects call was made with. */
function skippedEmbed(): unknown {
	expect(mockApplySideEffects).toHaveBeenCalledTimes(1);
	return mockApplySideEffects.mock.calls[0]?.[0].skipEmbed;
}

/** The document the side effects were handed. */
function sideEffectsDocument(): { status: string } {
	expect(mockApplySideEffects).toHaveBeenCalledTimes(1);
	return mockApplySideEffects.mock.calls[0]?.[0].document;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockApplySideEffects.mockResolvedValue(undefined);
	mockFanOutDocumentMention.mockResolvedValue(undefined);
	mockFanOutSubscriptionUpdate.mockResolvedValue(undefined);
	mockProjectDocumentFindUnique.mockResolvedValue(priorDocument());
	mockUpdateDocument.mockResolvedValue(savedDocument());
	mockCompleteDraftDocument.mockResolvedValue(true);
});

describe("updateDocumentProcedure — completing a draft the author asked to finish", () => {
	it("completes the draft on an explicit save, and says this request did it", async () => {
		const result = await update({ content: BODY, completeDraft: true });

		expect(mockCompleteDraftDocument).toHaveBeenCalledTimes(1);
		expect(mockCompleteDraftDocument).toHaveBeenCalledWith("doc_1");
		expect(result.draftCompleted).toBe(true);
		expect(result.document.status).toBe("COMPLETE");
	});

	it("completes it on the list's request, which carries no content", async () => {
		const result = await update({ completeDraft: true });

		expect(mockCompleteDraftDocument).toHaveBeenCalledWith("doc_1");
		expect(result.draftCompleted).toBe(true);
	});

	it("saves first and completes after, so the completion sees the saved content", async () => {
		await update({ content: BODY, completeDraft: true });

		expect(mockUpdateDocument.mock.invocationCallOrder[0]).toBeLessThan(
			mockCompleteDraftDocument.mock.invocationCallOrder[0],
		);
	});

	it("leaves the save itself exactly as it was: no status is written by it", async () => {
		await update({ content: BODY, completeDraft: true });

		const [, data] = mockUpdateDocument.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(data.status).toBeUndefined();
		expect(data).not.toHaveProperty("completeDraft");
	});
});

describe("updateDocumentProcedure — when it must not complete", () => {
	it("does not complete on a save that did not ask, so an autosave leaves a draft a draft", async () => {
		const result = await update({ content: BODY });

		expect(mockCompleteDraftDocument).not.toHaveBeenCalled();
		expect(result.draftCompleted).toBe(false);
		expect(result.document.status).toBe("DRAFT");
	});

	it.each([
		"QUEUED",
		"GENERATING",
		"IN_PROGRESS",
		"REVIEW",
		"COMPLETE",
		"FAILED",
	])("does not try on a document the save returns as %s", async (status) => {
		mockUpdateDocument.mockResolvedValue(savedDocument({ status }));

		const result = await update({ completeDraft: true });

		expect(mockCompleteDraftDocument).not.toHaveBeenCalled();
		expect(result.draftCompleted).toBe(false);
		expect(result.document.status).toBe(status);
	});

	it.each(["", "   \n\n"])(
		"does not complete a draft with no content (%j)",
		async (content) => {
			mockUpdateDocument.mockResolvedValue(savedDocument({ content }));

			const result = await update({ completeDraft: true });

			expect(mockCompleteDraftDocument).not.toHaveBeenCalled();
			expect(result.draftCompleted).toBe(false);
		},
	);

	it("does not complete an integration contract, whose status its run owns", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue(
			priorDocument({ type: "INTEGRATION_CONTRACT" }),
		);
		mockUpdateDocument.mockResolvedValue(
			savedDocument({ type: "INTEGRATION_CONTRACT" }),
		);

		const result = await update({ completeDraft: true });

		expect(mockCompleteDraftDocument).not.toHaveBeenCalled();
		expect(result.draftCompleted).toBe(false);
	});

	it("lets an explicit status win", async () => {
		mockUpdateDocument.mockResolvedValue(
			savedDocument({ status: "IN_PROGRESS" }),
		);

		const result = await update({
			status: "IN_PROGRESS",
			completeDraft: true,
		});

		expect(mockCompleteDraftDocument).not.toHaveBeenCalled();
		expect(result.document.status).toBe("IN_PROGRESS");
	});

	it("does not complete on a revert that skips the version bump", async () => {
		await update({
			content: BODY,
			skipVersionBump: true,
			completeDraft: true,
		});

		expect(mockCompleteDraftDocument).not.toHaveBeenCalled();
	});
});

describe("updateDocumentProcedure — when the guarded write completes nothing", () => {
	// The save returned a draft, and before the completion landed a generation
	// picked the document up (or someone else completed it). The guarded write
	// matched no row, so this request completed nothing.
	beforeEach(() => {
		mockCompleteDraftDocument.mockResolvedValue(false);
	});

	it("does not claim the completion", async () => {
		const result = await update({ completeDraft: true });

		expect(mockCompleteDraftDocument).toHaveBeenCalledTimes(1);
		expect(result.draftCompleted).toBe(false);
		expect(result.document.status).toBe("DRAFT");
	});

	it("does not embed or announce a completion that was not its own", async () => {
		await update({ completeDraft: true });

		expect(skippedEmbed()).toBe(true);
		expect(mockFanOutSubscriptionUpdate).not.toHaveBeenCalled();
	});
});

describe("updateDocumentProcedure — embedding a document that became COMPLETE", () => {
	it("embeds a draft that a request with no content has completed", async () => {
		await update({ completeDraft: true });

		expect(skippedEmbed()).toBe(false);
		// The embed runs only for a COMPLETE document, so it has to be handed
		// the document as completed, not the draft the save returned.
		expect(sideEffectsDocument().status).toBe("COMPLETE");
	});

	it("embeds a document that an explicit status has marked complete", async () => {
		mockUpdateDocument.mockResolvedValue(
			savedDocument({ status: "COMPLETE" }),
		);

		await update({ status: "COMPLETE" });

		expect(skippedEmbed()).toBe(false);
	});

	it("still skips the embed for a status-only update that does not complete", async () => {
		mockUpdateDocument.mockResolvedValue(
			savedDocument({ status: "REVIEW" }),
		);

		await update({ status: "REVIEW" });

		expect(skippedEmbed()).toBe(true);
	});

	it("still skips the embed for a title-only save of a document that was already complete", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue(
			priorDocument({ status: "COMPLETE" }),
		);
		mockUpdateDocument.mockResolvedValue(
			savedDocument({ status: "COMPLETE", title: "Renamed" }),
		);

		await update({ title: "Renamed" });

		expect(skippedEmbed()).toBe(true);
	});

	it("does not embed again when a stale request finds the document already complete", async () => {
		// The requester's view said DRAFT; the save's own read says COMPLETE.
		// Nothing was completed here, so there is nothing new to embed.
		mockUpdateDocument.mockResolvedValue(
			savedDocument({ status: "COMPLETE" }),
		);

		await update({ completeDraft: true });

		expect(mockCompleteDraftDocument).not.toHaveBeenCalled();
		expect(skippedEmbed()).toBe(true);
		expect(mockFanOutSubscriptionUpdate).not.toHaveBeenCalled();
	});
});

describe("updateDocumentProcedure — telling watchers a draft was completed", () => {
	it("reports a status change when a save completes a draft without changing its content", async () => {
		// The already-stuck document: saved again with the same body. The
		// version does not move, so without this it would notify nobody.
		await update({ content: BODY, completeDraft: true });

		expect(mockFanOutSubscriptionUpdate).toHaveBeenCalledTimes(1);
		expect(mockFanOutSubscriptionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				subjectId: "doc_1",
				changeKind: "status",
			}),
		);
	});

	it("stays silent when a save leaves a draft a draft and changes nothing", async () => {
		await update({ content: BODY });

		expect(mockFanOutSubscriptionUpdate).not.toHaveBeenCalled();
	});
});

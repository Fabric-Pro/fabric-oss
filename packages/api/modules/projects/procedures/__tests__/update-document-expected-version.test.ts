/**
 * The optional `expectedVersion` guard on `updateDocumentProcedure`
 * (Fizzy #2589, KTD17).
 *
 * The in-editor assistant accept sends it when a visual slot is involved, so
 * a save that raced another writer leaves the document untouched instead of
 * overwriting it with a body whose slots were lifted from an older version:
 *  - given     ⇒ passed through to `updateDocument`;
 *  - conflict  ⇒ CONFLICT with a fixed message, and no side effect runs;
 *  - absent    ⇒ the exact unguarded call every other save makes;
 *  - authorization and the document-to-project binding still come first.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockHasProjectAccess,
	mockUpdateDocument,
	mockApplySideEffects,
	mockProjectDocumentFindUnique,
	mockFanOutDocumentMention,
	mockFanOutSubscriptionUpdate,
	DocumentVersionConflictErrorMock,
} = vi.hoisted(() => {
	class DocumentVersionConflictErrorMock extends Error {
		constructor(
			readonly documentId: string,
			readonly expectedVersion: number,
			readonly actualVersion: number,
		) {
			super(
				`Document ${documentId} moved from version ${expectedVersion} to ${actualVersion} while the update was being prepared.`,
			);
			this.name = "DocumentVersionConflictError";
		}
	}
	return {
		handlers: {} as Record<string, (...args: unknown[]) => unknown>,
		mockHasProjectAccess: vi.fn(),
		mockUpdateDocument: vi.fn(),
		mockApplySideEffects: vi.fn(),
		mockProjectDocumentFindUnique: vi.fn(),
		mockFanOutDocumentMention: vi.fn(),
		mockFanOutSubscriptionUpdate: vi.fn(),
		DocumentVersionConflictErrorMock,
	};
});

vi.mock("@repo/database", () => ({
	DocumentVersionConflictError: DocumentVersionConflictErrorMock,
	IntegrationContractStatusManagedError: class extends Error {},
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
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

const SLOTTED = `## Phases\n\nOne, then two.\n\n<visual-slot id="slot-a" kind="timeline"></visual-slot>`;

const input = {
	projectId: "proj_1",
	id: "doc_1",
	organizationId: "org_1",
	content: SLOTTED,
};

async function flushPromises() {
	// Let any fire-and-forget fan-out settle so it never leaks into a later
	// test (and so a test asserting "no fan-out" sees the final count).
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockApplySideEffects.mockResolvedValue(undefined);
	mockFanOutDocumentMention.mockResolvedValue(undefined);
	mockFanOutSubscriptionUpdate.mockResolvedValue(undefined);
	mockProjectDocumentFindUnique.mockResolvedValue({
		projectId: "proj_1",
		content: "## Phases\n\nOne.",
		title: "Business case",
		status: "DRAFT",
		type: "BUSINESS_CASE",
		version: 3,
	});
	mockUpdateDocument.mockResolvedValue({
		id: "doc_1",
		title: "Business case",
		content: SLOTTED,
		version: 4,
	});
});

describe("updateDocumentProcedure — optional expectedVersion guard", () => {
	it("passes expectedVersion through to updateDocument when given", async () => {
		const result = (await handlers.updateDocument({
			input: { ...input, expectedVersion: 3 },
			context: ctx,
		})) as { document: { version: number } };
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({
				content: SLOTTED,
				expectedVersion: 3,
				userId: "actor_1",
				organizationId: "org_1",
			}),
		);
		expect(result.document.version).toBe(4);
		expect(mockApplySideEffects).toHaveBeenCalledTimes(1);
	});

	it("maps a version conflict to CONFLICT with a fixed message and runs no side effect", async () => {
		mockUpdateDocument.mockRejectedValue(
			new DocumentVersionConflictErrorMock("doc_1", 3, 5),
		);

		const error = await (
			handlers.updateDocument({
				input: { ...input, expectedVersion: 3 },
				context: ctx,
			}) as Promise<unknown>
		).catch((e: unknown) => e);
		await flushPromises();

		expect(error).toMatchObject({
			code: "CONFLICT",
			message:
				"The document changed while your changes were being saved, so nothing was saved. Review the latest version and apply your changes again.",
		});
		// The internal version numbers stay out of the client-facing message.
		expect((error as Error).message).not.toMatch(/moved from version/);
		expect(mockApplySideEffects).not.toHaveBeenCalled();
		expect(mockFanOutDocumentMention).not.toHaveBeenCalled();
		expect(mockFanOutSubscriptionUpdate).not.toHaveBeenCalled();
	});

	it("without expectedVersion makes exactly the unguarded call it always made", async () => {
		await handlers.updateDocument({ input, context: ctx });
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
		const [, data] = mockUpdateDocument.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(data).not.toHaveProperty("expectedVersion");
		expect(data).toEqual({
			title: undefined,
			content: SLOTTED,
			status: undefined,
			lastEditedBy: "actor_1",
			changeDescription: undefined,
			userId: "actor_1",
			organizationId: "org_1",
			skipVersionBump: undefined,
		});
	});

	it("still refuses a caller without project access before any write", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		await expect(
			handlers.updateDocument({
				input: { ...input, expectedVersion: 3 },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockUpdateDocument).not.toHaveBeenCalled();
	});

	it("still refuses a document from another project before any write", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			projectId: "proj_other",
			content: "",
			title: "Elsewhere",
			status: "DRAFT",
			type: "BUSINESS_CASE",
			version: 3,
		});

		await expect(
			handlers.updateDocument({
				input: { ...input, expectedVersion: 3 },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockUpdateDocument).not.toHaveBeenCalled();
	});
});

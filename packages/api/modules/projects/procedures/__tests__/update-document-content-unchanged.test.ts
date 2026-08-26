/**
 * Backstop signal for `updateDocumentProcedure`.
 *
 * `updateDocument` bumps `version` only on a normalized content change, so a
 * content-bearing save that leaves the version untouched was a no-op. The
 * additive `contentUnchanged` response field surfaces that:
 *  - content-bearing no-op save  ⇒ contentUnchanged: true
 *  - real content change         ⇒ contentUnchanged: false
 *  - metadata-only update        ⇒ contentUnchanged: false
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
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockHasProjectAccess: vi.fn(),
	mockUpdateDocument: vi.fn(),
	mockApplySideEffects: vi.fn(),
	mockProjectDocumentFindUnique: vi.fn(),
	mockFanOutDocumentMention: vi.fn(),
	mockFanOutSubscriptionUpdate: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
	// Real implementation, not a stub: it is a pure string builder, and the
	// notification link is worth asserting against rather than mocking away.
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

async function flushPromises() {
	// Let the fire-and-forget fan-out dispatches settle so they never leak into
	// a later test.
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockApplySideEffects.mockResolvedValue(undefined);
	mockFanOutDocumentMention.mockResolvedValue(undefined);
	mockFanOutSubscriptionUpdate.mockResolvedValue(undefined);
});

describe("updateDocumentProcedure — contentUnchanged backstop", () => {
	it("returns contentUnchanged:true on a content-bearing no-op save", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			projectId: "proj_1",
			content: "# Spec\n\nBody.",
			title: "PRD",
			status: "DRAFT",
			version: 3,
		});
		// updateDocument no-oped: the same version comes back.
		mockUpdateDocument.mockResolvedValue({
			id: "doc_1",
			title: "PRD",
			content: "# Spec\n\nBody.",
			version: 3,
		});

		const result = (await handlers.updateDocument({
			input: { ...baseInput, content: "# Spec\n\nBody." },
			context: ctx,
		})) as { contentUnchanged: boolean };
		await flushPromises();

		expect(result.contentUnchanged).toBe(true);
	});

	it("returns contentUnchanged:false on a real content change", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			projectId: "proj_1",
			content: "# Spec\n\nOld body.",
			title: "PRD",
			status: "DRAFT",
			version: 3,
		});
		mockUpdateDocument.mockResolvedValue({
			id: "doc_1",
			title: "PRD",
			content: "# Spec\n\nNew body.",
			version: 4,
		});

		const result = (await handlers.updateDocument({
			input: { ...baseInput, content: "# Spec\n\nNew body." },
			context: ctx,
		})) as { contentUnchanged: boolean };
		await flushPromises();

		expect(result.contentUnchanged).toBe(false);
	});

	it("returns contentUnchanged:false on a metadata-only update (no content in input)", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			projectId: "proj_1",
			content: "# Spec\n\nBody.",
			title: "PRD",
			status: "DRAFT",
			version: 3,
		});
		// Title-only save: updateDocument leaves the version untouched.
		mockUpdateDocument.mockResolvedValue({
			id: "doc_1",
			title: "Renamed PRD",
			content: "# Spec\n\nBody.",
			version: 3,
		});

		const result = (await handlers.updateDocument({
			input: { ...baseInput, title: "Renamed PRD" },
			context: ctx,
		})) as { contentUnchanged: boolean };
		await flushPromises();

		expect(result.contentUnchanged).toBe(false);
	});
});

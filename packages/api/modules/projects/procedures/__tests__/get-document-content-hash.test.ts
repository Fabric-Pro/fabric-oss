/**
 * `projects.documents.get` returns the body's identity (Fizzy #2946): the
 * SHA-256 of the stored body, beside its version. A collaborative editor room
 * records the pair as the base of the body it holds, and a save names it back,
 * so the hash must be of the stored body itself, never of the run's live
 * preview, and it replaces the embed-owned `contentHash` column, which can lag
 * the body.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockHasProjectAccess,
	mockGetDocumentById,
	mockAdoptDocumentIntoProjectTenant,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockHasProjectAccess: vi.fn(),
	mockGetDocumentById: vi.fn(),
	mockAdoptDocumentIntoProjectTenant: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	getDocumentById: (...args: unknown[]) => mockGetDocumentById(...args),
	adoptDocumentIntoProjectTenant: (...args: unknown[]) =>
		mockAdoptDocumentIntoProjectTenant(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.getDocument = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
		requireProjectPermission: () => (c: unknown) => c,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

// Side-effect: register the handler.
import "../get-document";

const ctx = {
	user: { id: "user_1", name: "Alice" },
	session: { id: "session-1", activeOrganizationId: "org_1" },
};

const BODY = "## Scope\n\nThe saved body.";

function sha256(text: string) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockAdoptDocumentIntoProjectTenant.mockResolvedValue("org_1");
	mockGetDocumentById.mockResolvedValue({
		id: "doc_1",
		projectId: "proj_1",
		organizationId: "org_1",
		type: "PROPOSAL",
		title: "Proposal",
		content: BODY,
		liveContent: "## Scope\n\nA preview still streaming.",
		version: 7,
		// The embed-owned column: a short hash of an older body.
		contentHash: "0123456789abcdef",
		currentContentHash: "fedcba9876543210",
	});
});

describe("getDocumentProcedure — the body's identity", () => {
	it("returns the SHA-256 of the stored body beside its version", async () => {
		const result = (await handlers.getDocument({
			input: {
				projectId: "proj_1",
				id: "doc_1",
				organizationId: "org_1",
			},
			context: ctx,
		})) as {
			document: { version: number; contentHash: string };
		};

		expect(result.document.version).toBe(7);
		expect(result.document.contentHash).toBe(sha256(BODY));
		// Not the live preview's, and not the embed column's.
		expect(result.document.contentHash).not.toBe(
			sha256("## Scope\n\nA preview still streaming."),
		);
	});

	it("returns the empty body's identity for a draft nothing has embedded", async () => {
		mockGetDocumentById.mockResolvedValue({
			id: "doc_1",
			projectId: "proj_1",
			organizationId: "org_1",
			type: "PROPOSAL",
			title: "Proposal",
			status: "DRAFT",
			content: "",
			liveContent: null,
			version: 1,
			// The embed-owned column of a draft that was never embedded.
			contentHash: null,
			currentContentHash: "e3b0c44298fc1c14",
		});

		const result = (await handlers.getDocument({
			input: {
				projectId: "proj_1",
				id: "doc_1",
				organizationId: "org_1",
			},
			context: ctx,
		})) as {
			document: { version: number; contentHash: string | null };
		};

		expect(result.document.version).toBe(1);
		expect(result.document.contentHash).toBe(sha256(""));
	});

	it("leaves the decision pre-check's short hash as it was", async () => {
		const result = (await handlers.getDocument({
			input: {
				projectId: "proj_1",
				id: "doc_1",
				organizationId: "org_1",
			},
			context: ctx,
		})) as { document: { currentContentHash: string } };

		expect(result.document.currentContentHash).toBe("fedcba9876543210");
	});

	it("still refuses a document from another project", async () => {
		mockGetDocumentById.mockResolvedValue({
			id: "doc_1",
			projectId: "proj_other",
			content: BODY,
			version: 7,
		});

		await expect(
			handlers.getDocument({
				input: {
					projectId: "proj_1",
					id: "doc_1",
					organizationId: "org_1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

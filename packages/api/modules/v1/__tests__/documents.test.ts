/**
 * v1 documents — Phase 8a integration tests
 *
 * Exercises the project-scoped documents routes via Hono request().
 * Confirms access gating (hasProjectAccess for reads, canEditProject
 * for writes), validation, and the underlying DB call shape.
 */

import { contentIdentity } from "@repo/utils/content-identity";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListDocuments = vi.fn();
const mockGetDocumentById = vi.fn();
const mockCreateDocument = vi.fn();
const mockUpdateDocument = vi.fn();
const mockHasProjectAccess = vi.fn();
const mockCanEditProject = vi.fn();
const mockIsProposalClientDocument = vi.fn();
const { mockEmitDocumentChange } = vi.hoisted(() => ({
	mockEmitDocumentChange: vi.fn(),
}));

const { IntegrationContractStatusManagedErrorMock } = vi.hoisted(() => {
	class IntegrationContractStatusManagedErrorMock extends Error {
		readonly code = "INTEGRATION_CONTRACT_STATUS_MANAGED" as const;
	}
	return { IntegrationContractStatusManagedErrorMock };
});

const { DocumentVersionConflictErrorMock } = vi.hoisted(() => {
	class DocumentVersionConflictErrorMock extends Error {}
	return { DocumentVersionConflictErrorMock };
});

const { DocumentGenerationInProgressErrorMock } = vi.hoisted(() => {
	class DocumentGenerationInProgressErrorMock extends Error {}
	return { DocumentGenerationInProgressErrorMock };
});

vi.mock("@repo/database", () => ({
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-test",
	})),
	IntegrationContractStatusManagedError:
		IntegrationContractStatusManagedErrorMock,
	DocumentVersionConflictError: DocumentVersionConflictErrorMock,
	DocumentGenerationInProgressError: DocumentGenerationInProgressErrorMock,
	isProposalClientDocument: (...args: unknown[]) =>
		mockIsProposalClientDocument(...args),
	listDocuments: (...args: unknown[]) => mockListDocuments(...args),
	getDocumentById: (...args: unknown[]) => mockGetDocumentById(...args),
	createDocument: (...args: unknown[]) => mockCreateDocument(...args),
	updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	canEditProject: (...args: unknown[]) => mockCanEditProject(...args),
	db: {
		organization: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
	},
}));

vi.mock("../../../lib/realtime", () => ({
	emitDocumentChange: (...args: unknown[]) => mockEmitDocumentChange(...args),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

import { registerDocumentRoutes } from "../documents";

function makeApp() {
	const app = new Hono<{
		Variables: {
			externalApiContext: {
				keyType: "personal" | "organization";
				keyId: string;
				keyPrefix: string;
				userId: string;
				organizationId: string | undefined;
				scopes: string[];
			};
		};
	}>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "personal",
			keyId: "key-1",
			keyPrefix: "fab_test",
			userId: "user-1",
			organizationId: undefined,
			scopes: ["documents:read", "documents:write"],
		});
		await next();
	});
	registerDocumentRoutes(app as never);
	return app;
}

function docRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc-1",
		projectId: "proj-1",
		type: "PRD" as const,
		title: "PRD",
		content: "# stub",
		status: "DRAFT" as const,
		version: 1,
		wordCount: 1,
		createdAt: new Date("2026-05-11T00:00:00.000Z"),
		updatedAt: new Date("2026-05-11T00:00:00.000Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockIsProposalClientDocument.mockResolvedValue(false);
});

describe("v1 documents — list/get", () => {
	it("GET /projects/:id/documents 404 when no project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const res = await makeApp().request("/projects/proj-x/documents");
		expect(res.status).toBe(404);
		expect(mockListDocuments).not.toHaveBeenCalled();
	});

	it("GET /projects/:id/documents lists with type filter", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockListDocuments.mockResolvedValue({
			documents: [docRow(), docRow({ id: "doc-2" })],
			total: 2,
			hasMore: false,
		});
		const res = await makeApp().request(
			"/projects/proj-1/documents?type=PRD&limit=5",
		);
		expect(res.status).toBe(200);
		expect(mockListDocuments).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				type: "PRD",
				limit: 5,
			}),
		);
		const body = (await res.json()) as {
			data: Array<{ id: string; content?: string }>;
		};
		expect(body.data).toHaveLength(2);
		// Summary shape — no content
		expect(body.data[0].content).toBeUndefined();
	});

	it("GET /projects/:id/documents still filters by a generation-owned status", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockListDocuments.mockResolvedValue({
			documents: [docRow({ status: "GENERATING" })],
			total: 1,
			hasMore: false,
		});
		const res = await makeApp().request(
			"/projects/proj-1/documents?status=GENERATING",
		);
		expect(res.status).toBe(200);
		expect(mockListDocuments).toHaveBeenCalledWith(
			expect.objectContaining({ status: "GENERATING" }),
		);
	});

	it("GET /projects/:id/documents 400 on invalid type filter", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		const res = await makeApp().request(
			"/projects/proj-1/documents?type=NOTATHING",
		);
		expect(res.status).toBe(400);
	});

	it("GET /documents/:id returns full content", async () => {
		mockGetDocumentById.mockResolvedValue(docRow({ content: "# Real" }));
		mockHasProjectAccess.mockResolvedValue(true);
		const res = await makeApp().request("/documents/doc-1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { content: string } };
		expect(body.data.content).toBe("# Real");
	});

	it("GET /documents/:id returns the base a PATCH sends back", async () => {
		mockGetDocumentById.mockResolvedValue(
			docRow({ content: "# Real", version: 4 }),
		);
		mockHasProjectAccess.mockResolvedValue(true);
		const res = await makeApp().request("/documents/doc-1");
		const body = (await res.json()) as {
			data: { version: number; contentHash: string };
		};
		expect(body.data.version).toBe(4);
		expect(body.data.contentHash).toBe(contentIdentity("# Real"));
	});

	it("GET /documents/:id 404 when document doesn't exist", async () => {
		mockGetDocumentById.mockResolvedValue(null);
		const res = await makeApp().request("/documents/missing");
		expect(res.status).toBe(404);
	});

	it("GET /documents/:id 404 when caller has no project access (cross-tenant)", async () => {
		mockGetDocumentById.mockResolvedValue(docRow());
		mockHasProjectAccess.mockResolvedValue(false);
		const res = await makeApp().request("/documents/doc-1");
		expect(res.status).toBe(404);
	});
});

describe("v1 documents — create", () => {
	beforeEach(() => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockCanEditProject.mockResolvedValue(true);
		mockCreateDocument.mockResolvedValue(docRow());
	});

	it("happy path creates and returns 201", async () => {
		const res = await makeApp().request("/projects/proj-1/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "TECHNICAL_SPEC",
				title: "Spec",
				content: "# spec",
			}),
		});
		expect(res.status).toBe(201);
		expect(mockCreateDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				type: "TECHNICAL_SPEC",
				title: "Spec",
				content: "# spec",
				status: "DRAFT",
				userId: "user-1",
			}),
		);
	});

	it("404 when caller has no project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const res = await makeApp().request("/projects/proj-x/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "PRD",
				title: "x",
				content: "x",
			}),
		});
		expect(res.status).toBe(404);
		expect(mockCreateDocument).not.toHaveBeenCalled();
	});

	it("403 when read access but no edit permission", async () => {
		mockCanEditProject.mockResolvedValue(false);
		const res = await makeApp().request("/projects/proj-1/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "PRD",
				title: "x",
				content: "x",
			}),
		});
		expect(res.status).toBe(403);
		expect(mockCreateDocument).not.toHaveBeenCalled();
	});

	it("400 on missing required fields", async () => {
		const res = await makeApp().request("/projects/proj-1/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "PRD", title: "no content" }),
		});
		expect(res.status).toBe(400);
	});

	it("400 on invalid type enum", async () => {
		const res = await makeApp().request("/projects/proj-1/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "NOT_A_TYPE",
				title: "x",
				content: "x",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 on empty title", async () => {
		const res = await makeApp().request("/projects/proj-1/documents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "PRD",
				title: "   ",
				content: "x",
			}),
		});
		expect(res.status).toBe(400);
	});

	// QUEUED and GENERATING are set by generation dispatch with the run's
	// workflow id and start time. A row a caller puts in either status has
	// neither, so the run guard would refuse every later write and the
	// watchdog could never move it on (Fizzy #2946).
	it.each([
		["PROPOSAL", "GENERATING"],
		["PROPOSAL", "QUEUED"],
		["PRD", "QUEUED"],
		["PRD", "GENERATING"],
	])(
		"refuses to create a %s in the generation-owned status %s",
		async (type, status) => {
			const res = await makeApp().request("/projects/proj-1/documents", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type,
					title: "Proposal",
					content: "# body",
					status,
				}),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code?: string } };
			expect(body.error.code).toBe("DOCUMENT_STATUS_GENERATION_OWNED");
			expect(mockCreateDocument).not.toHaveBeenCalled();
		},
	);

	it.each(["DRAFT", "COMPLETE"])(
		"still creates a Proposal with status %s",
		async (status) => {
			const res = await makeApp().request("/projects/proj-1/documents", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: "PROPOSAL",
					title: "Proposal",
					content: "# body",
					status,
				}),
			});
			expect(res.status).toBe(201);
			expect(mockCreateDocument).toHaveBeenCalledWith(
				expect.objectContaining({ type: "PROPOSAL", status }),
			);
		},
	);
});

describe("v1 documents — update", () => {
	beforeEach(() => {
		mockGetDocumentById.mockResolvedValue(docRow());
		mockHasProjectAccess.mockResolvedValue(true);
		mockCanEditProject.mockResolvedValue(true);
		mockUpdateDocument.mockResolvedValue(docRow({ title: "Renamed" }));
	});

	it("happy path updates title + status", async () => {
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Renamed", status: "COMPLETE" }),
		});
		expect(res.status).toBe(200);
		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc-1",
			expect.objectContaining({
				title: "Renamed",
				status: "COMPLETE",
				userId: "user-1",
			}),
		);
	});

	it.each([
		["PROPOSAL", "QUEUED"],
		["PROPOSAL", "GENERATING"],
		["PRD", "QUEUED"],
		["PRD", "GENERATING"],
	])(
		"refuses to move a COMPLETE %s to the generation-owned status %s",
		async (type, status) => {
			mockGetDocumentById.mockResolvedValue(
				docRow({ type, status: "COMPLETE" }),
			);
			const res = await makeApp().request("/documents/doc-1", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code?: string } };
			expect(body.error.code).toBe("DOCUMENT_STATUS_GENERATION_OWNED");
			expect(mockUpdateDocument).not.toHaveBeenCalled();
		},
	);

	it("still moves a COMPLETE Proposal back to DRAFT", async () => {
		mockGetDocumentById.mockResolvedValue(
			docRow({ type: "PROPOSAL", status: "COMPLETE" }),
		);
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "DRAFT" }),
		});
		expect(res.status).toBe(200);
		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc-1",
			expect.objectContaining({ status: "DRAFT" }),
		);
	});

	it("409 when changing an INTEGRATION_CONTRACT's status (owned by the discovery run)", async () => {
		mockGetDocumentById.mockResolvedValue(
			docRow({ type: "INTEGRATION_CONTRACT", status: "REVIEW" }),
		);
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "COMPLETE" }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code?: string } };
		expect(body.error.code).toBe("INTEGRATION_CONTRACT_STATUS_MANAGED");
		expect(mockUpdateDocument).not.toHaveBeenCalled();
	});

	it("maps the query-layer guard to 409 when the contract completed after the pre-read", async () => {
		mockGetDocumentById.mockResolvedValue(
			docRow({ type: "INTEGRATION_CONTRACT", status: "REVIEW" }),
		);
		mockUpdateDocument.mockRejectedValue(
			new IntegrationContractStatusManagedErrorMock("managed"),
		);
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "# edited", status: "REVIEW" }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code?: string } };
		expect(body.error.code).toBe("INTEGRATION_CONTRACT_STATUS_MANAGED");
	});

	it("still lets an INTEGRATION_CONTRACT's content be edited with its status unchanged", async () => {
		mockGetDocumentById.mockResolvedValue(
			docRow({ type: "INTEGRATION_CONTRACT", status: "REVIEW" }),
		);
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "# edited", status: "REVIEW" }),
		});
		expect(res.status).toBe(200);
		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
	});

	it("404 when document missing", async () => {
		mockGetDocumentById.mockResolvedValue(null);
		const res = await makeApp().request("/documents/missing", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "x" }),
		});
		expect(res.status).toBe(404);
	});

	it("404 when caller has no project access (cross-tenant)", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "x" }),
		});
		expect(res.status).toBe(404);
		expect(mockUpdateDocument).not.toHaveBeenCalled();
	});

	it("403 when read access but no edit permission", async () => {
		mockCanEditProject.mockResolvedValue(false);
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "x" }),
		});
		expect(res.status).toBe(403);
	});

	it("400 when no recognized fields", async () => {
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("400 on invalid status enum", async () => {
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "NOTASTATUS" }),
		});
		expect(res.status).toBe(400);
	});
});

// Open editors refetch on `document_change`, so a collaborative room holding
// the body an API write replaced brings itself to the saved one instead of
// saving the older body back (Fizzy #2946).
describe("v1 documents — update nudges open editors", () => {
	beforeEach(() => {
		mockGetDocumentById.mockResolvedValue(docRow());
		mockHasProjectAccess.mockResolvedValue(true);
		mockCanEditProject.mockResolvedValue(true);
		mockEmitDocumentChange.mockResolvedValue(undefined);
	});

	it("emits document_change once after a content update", async () => {
		mockUpdateDocument.mockResolvedValue(
			docRow({ content: "# edited", version: 2 }),
		);
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "# edited" }),
		});

		expect(res.status).toBe(200);
		expect(mockEmitDocumentChange).toHaveBeenCalledTimes(1);
		expect(mockEmitDocumentChange).toHaveBeenCalledWith({
			projectId: "proj-1",
			documentId: "doc-1",
			action: "updated",
			userId: "user-1",
			userName: "Fabric API",
			documentType: "PRD",
			documentTitle: "PRD",
		});
	});

	it("emits after a title-only update too, as the editor's own save does", async () => {
		mockUpdateDocument.mockResolvedValue(docRow({ title: "Renamed" }));
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Renamed" }),
		});

		expect(res.status).toBe(200);
		expect(mockEmitDocumentChange).toHaveBeenCalledTimes(1);
		expect(mockEmitDocumentChange).toHaveBeenCalledWith(
			expect.objectContaining({ documentTitle: "Renamed" }),
		);
	});

	it("emits nothing when nothing was written", async () => {
		mockUpdateDocument.mockRejectedValue(
			new IntegrationContractStatusManagedErrorMock("managed"),
		);
		const refused = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "# edited" }),
		});
		mockCanEditProject.mockResolvedValue(false);
		const forbidden = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "# edited" }),
		});

		expect(refused.status).toBe(409);
		expect(forbidden.status).toBe(403);
		expect(mockEmitDocumentChange).not.toHaveBeenCalled();
	});
});

// A PATCH may name the base it read; a client-document Proposal's body is
// also written by generation runs, so its content writes are always guarded
// and refused while a run owns the body (Fizzy #2946).
describe("v1 documents — update base", () => {
	const READ_BODY = "# Proposal\n\nThe body the caller read.";
	const GENERATED_BODY = "# Proposal\n\nThe body a generation run saved.";

	// Stands in for the query layer's guard: a write that names a base is
	// refused unless the stored document still matches it.
	let stored: { content: string; version: number };
	let written: string[];

	function patch(body: Record<string, unknown>) {
		return makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function proposalRow(overrides: Record<string, unknown> = {}) {
		return docRow({
			type: "PROPOSAL",
			title: "Proposal",
			content: READ_BODY,
			version: 3,
			project: { organizationId: "org-owner" },
			...overrides,
		});
	}

	beforeEach(() => {
		stored = { content: READ_BODY, version: 3 };
		written = [];
		mockHasProjectAccess.mockResolvedValue(true);
		mockCanEditProject.mockResolvedValue(true);
		mockEmitDocumentChange.mockResolvedValue(undefined);
		mockUpdateDocument.mockImplementation(
			async (
				_id: string,
				data: {
					content?: string;
					expectedVersion?: number;
					expectedContentHash?: string;
				},
			) => {
				if (
					(data.expectedVersion !== undefined &&
						data.expectedVersion !== stored.version) ||
					(data.expectedContentHash !== undefined &&
						data.expectedContentHash !==
							contentIdentity(stored.content))
				) {
					throw new DocumentVersionConflictErrorMock("moved");
				}
				if (data.content !== undefined) {
					written.push(data.content);
					stored = {
						content: data.content,
						version: stored.version + 1,
					};
				}
				return docRow({
					content: stored.content,
					version: stored.version,
				});
			},
		);
	});

	it("passes the caller's base to the write", async () => {
		mockGetDocumentById.mockResolvedValue(docRow({ version: 3 }));
		stored = { content: "# stub", version: 3 };

		const res = await patch({
			content: "# edited",
			expectedVersion: 3,
			expectedContentHash: contentIdentity("# stub"),
		});

		expect(res.status).toBe(200);
		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc-1",
			expect.objectContaining({
				expectedVersion: 3,
				expectedContentHash: contentIdentity("# stub"),
			}),
		);
		const body = (await res.json()) as { data: { contentHash: string } };
		expect(body.data.contentHash).toBe(contentIdentity("# edited"));
	});

	it("409s on a stale base and writes nothing", async () => {
		mockGetDocumentById.mockResolvedValue(docRow({ version: 4 }));
		stored = { content: "# newer save", version: 4 };

		const res = await patch({
			content: "# edited",
			expectedVersion: 3,
			expectedContentHash: contentIdentity("# stub"),
		});

		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code?: string } };
		expect(body.error.code).toBe("DOCUMENT_VERSION_CONFLICT");
		expect(written).toEqual([]);
		expect(mockEmitDocumentChange).not.toHaveBeenCalled();
	});

	it("400s on a malformed base", async () => {
		mockGetDocumentById.mockResolvedValue(docRow());

		const badVersion = await patch({
			content: "# x",
			expectedVersion: "3",
			expectedContentHash: contentIdentity("# stub"),
		});
		const badHash = await patch({
			content: "# x",
			expectedVersion: 1,
			expectedContentHash: "",
		});

		expect(badVersion.status).toBe(400);
		expect(badHash.status).toBe(400);
		expect(mockUpdateDocument).not.toHaveBeenCalled();
	});

	it.each([
		["only a version", { expectedVersion: 3 }],
		[
			"only a body identity",
			{ expectedContentHash: contentIdentity(READ_BODY) },
		],
	])("400s on half a base: %s", async (_name, base) => {
		mockIsProposalClientDocument.mockResolvedValue(true);
		mockGetDocumentById.mockResolvedValue(proposalRow());

		const res = await patch({ content: "# agent rewrite", ...base });

		expect(res.status).toBe(400);
		expect(mockUpdateDocument).not.toHaveBeenCalled();
	});

	// The gate's state must not matter: a run already in progress keeps
	// writing after the Proposal gate is turned off.
	it.each([
		["QUEUED", true],
		["GENERATING", true],
		["QUEUED", false],
		["GENERATING", false],
	])(
		"refuses a Proposal content write while it is %s (Proposal gate on: %s)",
		async (status, gateOn) => {
			mockIsProposalClientDocument.mockResolvedValue(gateOn);
			mockGetDocumentById.mockResolvedValue(proposalRow({ status }));

			const res = await patch({ content: "# agent rewrite" });

			expect(res.status).toBe(409);
			const body = (await res.json()) as { error: { code?: string } };
			expect(body.error.code).toBe("DOCUMENT_GENERATION_IN_PROGRESS");
			expect(mockUpdateDocument).not.toHaveBeenCalled();
			expect(mockEmitDocumentChange).not.toHaveBeenCalled();
		},
	);

	// The gate's state must not matter: a run already in progress keeps
	// writing after the Proposal gate is turned off.
	it.each([
		["QUEUED", true],
		["GENERATING", true],
		["QUEUED", false],
		["GENERATING", false],
	])(
		"refuses a Proposal status-only write while it is %s (Proposal gate on: %s)",
		async (status, gateOn) => {
			mockIsProposalClientDocument.mockResolvedValue(gateOn);
			mockGetDocumentById.mockResolvedValue(proposalRow({ status }));

			const res = await patch({ status: "COMPLETE" });

			expect(res.status).toBe(409);
			const body = (await res.json()) as { error: { code?: string } };
			expect(body.error.code).toBe("DOCUMENT_GENERATION_IN_PROGRESS");
			expect(mockUpdateDocument).not.toHaveBeenCalled();
			expect(mockEmitDocumentChange).not.toHaveBeenCalled();
		},
	);

	it("does not let a status write end a run's hold so a content write can follow", async () => {
		// Stands in for the stored row and the query layer's run guard.
		let storedStatus = "GENERATING";
		mockIsProposalClientDocument.mockResolvedValue(true);
		mockGetDocumentById.mockImplementation(async () =>
			proposalRow({ status: storedStatus }),
		);
		mockUpdateDocument.mockImplementation(
			async (
				_id: string,
				data: {
					content?: string;
					status?: string;
					refuseWhileGenerating?: boolean;
				},
			) => {
				if (
					data.refuseWhileGenerating &&
					(storedStatus === "QUEUED" || storedStatus === "GENERATING")
				) {
					throw new DocumentGenerationInProgressErrorMock();
				}
				if (data.status !== undefined) {
					storedStatus = data.status;
				}
				if (data.content !== undefined) {
					written.push(data.content);
				}
				return docRow({ status: storedStatus });
			},
		);

		const statusRes = await patch({ status: "COMPLETE" });
		const contentRes = await patch({ content: "# agent rewrite" });

		expect(statusRes.status).toBe(409);
		expect(contentRes.status).toBe(409);
		expect(storedStatus).toBe("GENERATING");
		expect(written).toEqual([]);
	});

	it("asks a status-only write to refuse a run queued after the read", async () => {
		mockIsProposalClientDocument.mockResolvedValue(true);
		mockGetDocumentById.mockResolvedValue(proposalRow());
		mockUpdateDocument.mockRejectedValue(
			new DocumentGenerationInProgressErrorMock(),
		);

		const res = await patch({ status: "COMPLETE" });

		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc-1",
			expect.objectContaining({
				status: "COMPLETE",
				refuseWhileGenerating: true,
			}),
		);
		// A status-only write carries no body, so it names no body base.
		expect(mockUpdateDocument.mock.calls[0][1]).not.toHaveProperty(
			"expectedContentHash",
		);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code?: string } };
		expect(body.error.code).toBe("DOCUMENT_GENERATION_IN_PROGRESS");
	});

	it("leaves a status-only write to a non-Proposal document unguarded during a run", async () => {
		mockGetDocumentById.mockResolvedValue(
			docRow({ version: 3, status: "GENERATING" }),
		);

		const res = await patch({ status: "COMPLETE" });

		expect(res.status).toBe(200);
		expect(mockUpdateDocument.mock.calls[0][1]).not.toHaveProperty(
			"refuseWhileGenerating",
		);
	});

	it("asks the write to refuse a run queued after the read, and answers 409 DOCUMENT_GENERATION_IN_PROGRESS", async () => {
		mockIsProposalClientDocument.mockResolvedValue(true);
		mockGetDocumentById.mockResolvedValue(proposalRow());
		mockUpdateDocument.mockRejectedValue(
			new DocumentGenerationInProgressErrorMock(),
		);

		const res = await patch({ content: "# agent rewrite" });

		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc-1",
			expect.objectContaining({ refuseWhileGenerating: true }),
		);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code?: string } };
		expect(body.error.code).toBe("DOCUMENT_GENERATION_IN_PROGRESS");
		expect(mockEmitDocumentChange).not.toHaveBeenCalled();
	});

	it("guards a finished Proposal's write with the Proposal gate off, without consulting it", async () => {
		mockIsProposalClientDocument.mockResolvedValue(false);
		mockGetDocumentById.mockResolvedValue(proposalRow());

		const res = await patch({ content: "# agent rewrite" });

		expect(res.status).toBe(200);
		expect(mockIsProposalClientDocument).not.toHaveBeenCalled();
		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc-1",
			expect.objectContaining({
				expectedVersion: 3,
				expectedContentHash: contentIdentity(READ_BODY),
				refuseWhileGenerating: true,
			}),
		);
	});

	it("guards a client-document Proposal write without a base by the body it read", async () => {
		mockIsProposalClientDocument.mockResolvedValue(true);
		mockGetDocumentById.mockImplementation(async () => {
			const row = proposalRow();
			// A run's final save lands after the read, at the same version.
			stored = { content: GENERATED_BODY, version: 3 };
			return row;
		});

		const res = await patch({ content: "# agent rewrite" });

		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code?: string } };
		expect(body.error.code).toBe("DOCUMENT_VERSION_CONFLICT");
		expect(written).toEqual([]);
		expect(stored.content).toBe(GENERATED_BODY);
		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc-1",
			expect.objectContaining({
				expectedVersion: 3,
				expectedContentHash: contentIdentity(READ_BODY),
			}),
		);
	});

	it("lets a client-document Proposal title change through during a run", async () => {
		mockIsProposalClientDocument.mockResolvedValue(true);
		mockGetDocumentById.mockResolvedValue(
			proposalRow({ status: "GENERATING" }),
		);

		const res = await patch({ title: "Proposal for example-org" });

		expect(res.status).toBe(200);
		expect(mockUpdateDocument.mock.calls[0][1]).not.toHaveProperty(
			"expectedContentHash",
		);
	});

	it("keeps a PRD write without a base unguarded", async () => {
		mockGetDocumentById.mockResolvedValue(docRow({ version: 3 }));

		const res = await patch({ content: "# edited" });

		expect(res.status).toBe(200);
		expect(mockUpdateDocument.mock.calls[0][1]).not.toHaveProperty(
			"refuseWhileGenerating",
		);
		const options = mockUpdateDocument.mock.calls[0][1];
		expect(options).not.toHaveProperty("expectedVersion");
		expect(options).not.toHaveProperty("expectedContentHash");
		expect(written).toEqual(["# edited"]);
	});
});

/**
 * v1 documents — visual slots survive an API-key update (Fizzy #2589,
 * KTD17, R39).
 *
 * PATCH /documents/:id replaces the whole body. The route strips every slot
 * tag from the incoming body and splices back the slots the stored body holds
 * — the row it already read to authorize the write — so an API-key writer can
 * neither lose, double, nor introduce a slot. The slot helper runs for real;
 * only `@repo/database` and the scope middleware are mocked, as in
 * documents.test.ts.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetDocumentById = vi.fn();
const mockUpdateDocument = vi.fn();
const mockHasProjectAccess = vi.fn();
const mockCanEditProject = vi.fn();

vi.mock("@repo/database", () => ({
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-test",
	})),
	IntegrationContractStatusManagedError: class extends Error {},
	DocumentVersionConflictError: class DocumentVersionConflictError extends Error {},
	listDocuments: vi.fn(),
	getDocumentById: (...args: unknown[]) => mockGetDocumentById(...args),
	createDocument: vi.fn(),
	updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	canEditProject: (...args: unknown[]) => mockCanEditProject(...args),
	db: {
		organization: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
	},
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

const SLOT =
	'<visual-slot data-slot-id="slot-1" data-kind="timeline" data-hint="Delivery phases"></visual-slot>';

const WITH_SLOT = [
	"# Business Case",
	"",
	"## Implementation Phases",
	"",
	"Phase one covers discovery.",
	"",
	SLOT,
	"",
	"Phase two covers delivery.",
	"",
	"## Costs",
	"",
	"Costs are fixed.",
].join("\n");

const WITHOUT_SLOT = [
	"# Business Case",
	"",
	"## Implementation Phases",
	"",
	"Phase one covers discovery.",
	"",
	"Phase two covers delivery.",
	"",
	"## Costs",
	"",
	"Costs are fixed.",
].join("\n");

function docRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc-1",
		projectId: "proj-1",
		type: "BUSINESS_CASE" as const,
		title: "Business Case",
		content: WITH_SLOT,
		status: "DRAFT" as const,
		version: 1,
		wordCount: 20,
		createdAt: new Date("2026-05-11T00:00:00.000Z"),
		updatedAt: new Date("2026-05-11T00:00:00.000Z"),
		...overrides,
	};
}

function slotCount(markdown: string): number {
	return markdown.match(/<visual-slot\b/g)?.length ?? 0;
}

async function patchContent(content: string): Promise<string> {
	const res = await makeApp().request("/documents/doc-1", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ content }),
	});
	expect(res.status).toBe(200);
	expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
	return mockUpdateDocument.mock.calls[0][1].content;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetDocumentById.mockResolvedValue(docRow());
	mockHasProjectAccess.mockResolvedValue(true);
	mockCanEditProject.mockResolvedValue(true);
	mockUpdateDocument.mockResolvedValue(docRow({ version: 2 }));
});

describe("v1 documents — update preserves visual slots", () => {
	it("keeps exactly one slot when the body already carries the stored one", async () => {
		const written = await patchContent(
			WITH_SLOT.replace("Costs are fixed.", "Costs are fixed per phase."),
		);

		expect(slotCount(written)).toBe(1);
		expect(written).toContain(SLOT);
		expect(written).toContain("Costs are fixed per phase.");
	});

	it("keeps the stored slot under its section when the body leaves it out", async () => {
		const written = await patchContent(
			WITHOUT_SLOT.replace(
				"Costs are fixed.",
				"Costs are fixed per phase.",
			),
		);

		expect(slotCount(written)).toBe(1);
		expect(written.indexOf(SLOT)).toBeGreaterThan(
			written.indexOf("Phase one covers discovery."),
		);
		expect(written.indexOf(SLOT)).toBeLessThan(
			written.indexOf("Phase two covers delivery."),
		);
		// Spliced from the read that authorized the write, not a second one.
		expect(mockGetDocumentById).toHaveBeenCalledTimes(1);
	});

	it("does not let an API key add a slot to a document that has none", async () => {
		mockGetDocumentById.mockResolvedValue(
			docRow({ content: WITHOUT_SLOT }),
		);

		const written = await patchContent(WITH_SLOT);

		expect(slotCount(written)).toBe(0);
		expect(written).toBe(WITHOUT_SLOT);
	});

	it("writes a slot-free body byte for byte when the stored body has no slot", async () => {
		mockGetDocumentById.mockResolvedValue(
			docRow({ content: WITHOUT_SLOT }),
		);
		const incoming = "# Business Case\r\n\n\n\nTrailing spaces stay.   \n";

		expect(await patchContent(incoming)).toBe(incoming);
	});

	it("leaves the body alone on an update that does not send content", async () => {
		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Renamed" }),
		});

		expect(res.status).toBe(200);
		expect(mockUpdateDocument.mock.calls[0][1]).not.toHaveProperty(
			"content",
		);
	});
});

// The spliced body is only right for the version its slots came from, so a
// write involving a slot is guarded by that version; slot-free writes are not.
describe("v1 documents — a slot-involving update is version-guarded", () => {
	function writeOptions() {
		return mockUpdateDocument.mock.calls[0][1] as Record<string, unknown>;
	}

	it("writes with the read's version when the stored body holds a slot", async () => {
		await patchContent(WITHOUT_SLOT);

		expect(writeOptions().expectedVersion).toBe(1);
	});

	it("keeps the unguarded write when neither body holds a slot", async () => {
		mockGetDocumentById.mockResolvedValue(
			docRow({ content: WITHOUT_SLOT }),
		);

		await patchContent(`${WITHOUT_SLOT}\n\nOne more line.`);

		expect(writeOptions()).not.toHaveProperty("expectedVersion");
	});

	it("answers 409 when the document moved under the write", async () => {
		const { DocumentVersionConflictError } = await import("@repo/database");
		mockUpdateDocument.mockRejectedValue(
			new DocumentVersionConflictError(),
		);

		const res = await makeApp().request("/documents/doc-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: WITHOUT_SLOT }),
		});

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: { code: "DOCUMENT_VERSION_CONFLICT" },
		});
	});
});

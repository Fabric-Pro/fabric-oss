/**
 * `loadDocumentForAutoRefresh` — the shared gate in front of both auto-refresh
 * enrollment procedures.
 *
 * The ordering here is the security property, not an implementation detail:
 *
 *   1. A document outside the requested project is NOT_FOUND.
 *   2. A document whose organization differs from the caller's is NOT_FOUND —
 *      never FORBIDDEN, which would confirm to an outsider that the id they
 *      guessed names a real document.
 *   3. FORBIDDEN is reserved for a caller who IS in the tenant but not in the
 *      project.
 *
 * The adoption branch (Fizzy #2210) sits between 1 and 2 and must not widen any
 * of them: a tenant-less document is repaired only for a caller who already
 * belongs to its project, and a non-member still gets NOT_FOUND rather than the
 * FORBIDDEN that would tell them the document exists.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getDocumentById: vi.fn(),
		hasProjectAccess: vi.fn(),
		adoptDocumentIntoProjectTenant: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	getDocumentById: mocks.getDocumentById,
	hasProjectAccess: mocks.hasProjectAccess,
	adoptDocumentIntoProjectTenant: mocks.adoptDocumentIntoProjectTenant,
}));

const { loadDocumentForAutoRefresh } = await import(
	"../auto-refresh-document-access"
);

const ORG = "org_1";
const OTHER_ORG = "org_2";
const PROJECT = "proj_1";
const DOCUMENT = "doc_1";
const USER = "user_1";

function documentRow(organizationId: string | null) {
	return { id: DOCUMENT, projectId: PROJECT, organizationId };
}

function load(organizationId: string | undefined = ORG) {
	return loadDocumentForAutoRefresh({
		documentId: DOCUMENT,
		projectId: PROJECT,
		userId: USER,
		organizationId,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.adoptDocumentIntoProjectTenant.mockResolvedValue(ORG);
});

describe("loadDocumentForAutoRefresh", () => {
	it("returns a document whose organization already matches, without adopting", async () => {
		mocks.getDocumentById.mockResolvedValue(documentRow(ORG));

		const document = await load();

		expect(document.organizationId).toBe(ORG);
		expect(mocks.adoptDocumentIntoProjectTenant).not.toHaveBeenCalled();
	});

	it("rejects a document belonging to another organization as NOT_FOUND", async () => {
		mocks.getDocumentById.mockResolvedValue(documentRow(OTHER_ORG));

		await expect(load()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.adoptDocumentIntoProjectTenant).not.toHaveBeenCalled();
	});

	// The reported defect: the row existed for every project-scoped query and
	// did not exist for this gate, so the control rendered and then failed.
	it("adopts a tenant-less document for a project member and then admits it", async () => {
		mocks.getDocumentById.mockResolvedValue(documentRow(null));

		const document = await load();

		expect(mocks.adoptDocumentIntoProjectTenant).toHaveBeenCalledWith(
			expect.objectContaining({ id: DOCUMENT, projectId: PROJECT }),
		);
		// The healed value, not the null it was read with — the caller copies
		// this into the settings row's own tenant columns.
		expect(document.organizationId).toBe(ORG);
	});

	it("does not adopt for a caller who is not in the project, and says NOT_FOUND", async () => {
		mocks.getDocumentById.mockResolvedValue(documentRow(null));
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(load()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.adoptDocumentIntoProjectTenant).not.toHaveBeenCalled();
	});

	// A project with no organization has nothing to inherit; adoption returns
	// null and the document stays personal-tenant. It must still not leak into
	// an organization caller's context.
	it("keeps a document NOT_FOUND when there is no organization to inherit", async () => {
		mocks.getDocumentById.mockResolvedValue(documentRow(null));
		mocks.adoptDocumentIntoProjectTenant.mockResolvedValue(null);

		await expect(load()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("still answers FORBIDDEN when the tenant matches but the project does not admit the caller", async () => {
		mocks.getDocumentById.mockResolvedValue(documentRow(ORG));
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(load()).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rejects a document from another project as NOT_FOUND", async () => {
		mocks.getDocumentById.mockResolvedValue({
			id: DOCUMENT,
			projectId: "proj_other",
			organizationId: ORG,
		});

		await expect(load()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

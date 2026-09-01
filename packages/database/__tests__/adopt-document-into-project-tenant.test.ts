/**
 * Tests for `adoptDocumentIntoProjectTenant` (Fizzy #2210).
 *
 * A document's organization is a denormalized copy of its project's. When the
 * copy was written from the creating session instead of from the project, a
 * session with no resolved organization left it null inside an org-owned
 * project — and the document then existed for every project-scoped query while
 * not existing for the auto-refresh tenant gate.
 *
 * What these tests pin is that the repair runs in ONE direction only. Filling a
 * null from the project is a repair; touching a populated organization would be
 * a cross-tenant write wearing a repair's clothes, and is exactly what the gate
 * downstream exists to prevent.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/adopt-document-into-project-tenant.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const projectFindUniqueMock = vi.fn();
const documentUpdateManyMock = vi.fn();
const versionUpdateManyMock = vi.fn();
const transactionMock = vi.fn(async (operations: unknown[]) => operations);

vi.mock("../prisma/client", () => ({
	db: {
		project: { findUnique: projectFindUniqueMock },
		projectDocument: { updateMany: documentUpdateManyMock },
		documentVersion: { updateMany: versionUpdateManyMock },
		$transaction: (operations: unknown[]) => transactionMock(operations),
	},
}));

const { adoptDocumentIntoProjectTenant } = await import(
	"../prisma/queries/projects/documents"
);

const DOCUMENT = "doc_1";
const PROJECT = "proj_1";
const ORG = "org_1";

beforeEach(() => {
	projectFindUniqueMock.mockReset();
	documentUpdateManyMock.mockReset();
	versionUpdateManyMock.mockReset();
	transactionMock.mockClear();
});

describe("adoptDocumentIntoProjectTenant", () => {
	it("fills a null organization from the parent project", async () => {
		projectFindUniqueMock.mockResolvedValue({ organizationId: ORG });

		const result = await adoptDocumentIntoProjectTenant({
			id: DOCUMENT,
			projectId: PROJECT,
			organizationId: null,
		});

		expect(result).toBe(ORG);
		expect(documentUpdateManyMock).toHaveBeenCalledWith({
			where: { id: DOCUMENT, organizationId: null },
			data: { organizationId: ORG },
		});
	});

	// The version snapshots were written by the same call with the same null.
	// Leaving them behind files a document's history under a different tenant
	// from the document itself.
	it("carries the document's own version history across with it", async () => {
		projectFindUniqueMock.mockResolvedValue({ organizationId: ORG });

		await adoptDocumentIntoProjectTenant({
			id: DOCUMENT,
			projectId: PROJECT,
			organizationId: null,
		});

		expect(versionUpdateManyMock).toHaveBeenCalledWith({
			where: { documentId: DOCUMENT, organizationId: null },
			data: { organizationId: ORG },
		});
	});

	// Both writes in one transaction: a document that moved tenant without its
	// history is a worse state than the one being repaired.
	it("writes the document and its history in a single transaction", async () => {
		projectFindUniqueMock.mockResolvedValue({ organizationId: ORG });

		await adoptDocumentIntoProjectTenant({
			id: DOCUMENT,
			projectId: PROJECT,
			organizationId: null,
		});

		expect(transactionMock).toHaveBeenCalledTimes(1);
		expect(transactionMock.mock.calls[0][0]).toHaveLength(2);
	});

	it("never touches a document that already has an organization", async () => {
		const result = await adoptDocumentIntoProjectTenant({
			id: DOCUMENT,
			projectId: PROJECT,
			organizationId: "org_already_set",
		});

		expect(result).toBe("org_already_set");
		expect(projectFindUniqueMock).not.toHaveBeenCalled();
		expect(documentUpdateManyMock).not.toHaveBeenCalled();
	});

	it("leaves the row alone when the project has no organization to give", async () => {
		projectFindUniqueMock.mockResolvedValue({ organizationId: null });

		const result = await adoptDocumentIntoProjectTenant({
			id: DOCUMENT,
			projectId: PROJECT,
			organizationId: null,
		});

		expect(result).toBeNull();
		expect(documentUpdateManyMock).not.toHaveBeenCalled();
	});

	it("does not invent a tenant when the project is gone", async () => {
		projectFindUniqueMock.mockResolvedValue(null);

		const result = await adoptDocumentIntoProjectTenant({
			id: DOCUMENT,
			projectId: PROJECT,
			organizationId: null,
		});

		expect(result).toBeNull();
		expect(documentUpdateManyMock).not.toHaveBeenCalled();
	});

	// The compare-and-set is the structural half of the one-direction rule: a
	// row that gained an organization between this read and this write keeps it.
	it("scopes the write to rows that are still null", async () => {
		projectFindUniqueMock.mockResolvedValue({ organizationId: ORG });

		await adoptDocumentIntoProjectTenant({
			id: DOCUMENT,
			projectId: PROJECT,
			organizationId: null,
		});

		for (const mock of [documentUpdateManyMock, versionUpdateManyMock]) {
			expect(mock.mock.calls[0][0].where).toMatchObject({
				organizationId: null,
			});
		}
	});
});

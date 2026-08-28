/**
 * `deleteProjectFromQdrantActivity` — collection resolution and error
 * classification.
 *
 * The activity used to delete from a hardcoded `project_contexts` (underscore)
 * while every writer resolves `project-contexts` / `project-contexts-org-<id>`
 * through `getCollectionName`. The names never matched, the delete 404'd, and
 * the 404 was classified as success — so an organization's project deletion
 * silently left its vectors behind.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	qdrantDelete: vi.fn(),
	qdrantGetCollections: vi.fn(),
	dbFindProject: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	loggerError: vi.fn(),
}));

// vitest 4.x rejects an arrow-function .mockImplementation here because the
// source calls `new QdrantClient(...)` and arrows aren't constructable.
vi.mock("@qdrant/js-client-rest", () => ({
	QdrantClient: class MockQdrantClient {
		delete = (...a: unknown[]) => mocks.qdrantDelete(...a);
		getCollections = (...a: unknown[]) => mocks.qdrantGetCollections(...a);
	},
}));
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		// The Qdrant activity never touches the database. Stub the client so a
		// regression that starts reading from it fails loudly here rather than
		// quietly opening a connection.
		db: { project: { findUnique: mocks.dbFindProject } },
	};
});
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));
vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: mocks.loggerWarn,
		error: mocks.loggerError,
		log: vi.fn(),
		debug: vi.fn(),
	},
}));
vi.mock("@repo/storage", () => ({
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

// `getCollectionName` is left REAL on purpose: the whole defect was the
// temporal side inventing its own name, so the test pins the shared resolver's
// actual output rather than a stub that could agree with a wrong literal.
import { deleteProjectFromQdrantActivity } from "../project-deletion";

const PERSONAL_COLLECTION = "project-contexts";
const ORG_ID = "orgexample1";
const ORG_COLLECTION = `project-contexts-org-${ORG_ID}`;
/** The name the two activities used to hardcode. Nothing may resolve to it. */
const LEGACY_UNDERSCORE_COLLECTION = "project_contexts";

function collectionsExisting(...names: string[]) {
	return { collections: names.map((name) => ({ name })) };
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.qdrantDelete.mockResolvedValue({ status: "acknowledged" });
	mocks.qdrantGetCollections.mockResolvedValue(
		collectionsExisting(PERSONAL_COLLECTION, ORG_COLLECTION),
	);
});

describe("deleteProjectFromQdrantActivity — collection resolution", () => {
	it("targets the bare base collection for a personal-tenant project", async () => {
		const res = await deleteProjectFromQdrantActivity({
			projectId: "p1",
		});

		expect(res).toEqual({ success: true });
		expect(mocks.qdrantDelete).toHaveBeenCalledTimes(1);
		expect(mocks.qdrantDelete).toHaveBeenCalledWith(PERSONAL_COLLECTION, {
			wait: true,
			filter: { must: [{ key: "projectId", match: { value: "p1" } }] },
		});
	});

	it("targets the per-organization collection for an organization project", async () => {
		const res = await deleteProjectFromQdrantActivity({
			projectId: "p1",
			organizationId: ORG_ID,
		});

		expect(res).toEqual({ success: true });
		expect(mocks.qdrantDelete).toHaveBeenCalledWith(ORG_COLLECTION, {
			wait: true,
			filter: {
				must: [
					{ key: "projectId", match: { value: "p1" } },
					{ key: "organizationId", match: { value: ORG_ID } },
				],
			},
		});
		// The invariant the bug violated: an organization's vectors are NEVER
		// deleted out of the personal collection, which does not hold them.
		expect(mocks.qdrantDelete).not.toHaveBeenCalledWith(
			PERSONAL_COLLECTION,
			expect.anything(),
		);
	});

	it("never addresses the legacy underscore collection", async () => {
		await deleteProjectFromQdrantActivity({ projectId: "p1" });
		await deleteProjectFromQdrantActivity({
			projectId: "p1",
			organizationId: ORG_ID,
		});

		for (const [collection] of mocks.qdrantDelete.mock.calls) {
			expect(collection).not.toBe(LEGACY_UNDERSCORE_COLLECTION);
		}
	});

	it("filters only on indexed payload keys — Qdrant 400s on unindexed ones", async () => {
		await deleteProjectFromQdrantActivity({
			projectId: "p1",
			organizationId: ORG_ID,
		});

		const [, options] = mocks.qdrantDelete.mock.calls[0] as [
			string,
			{ filter: { must: Array<{ key: string }> } },
		];
		const indexedKeys = [
			"contextId",
			"originalContextId",
			"projectId",
			"organizationId",
		];
		for (const clause of options.filter.must) {
			expect(indexedKeys).toContain(clause.key);
		}
	});
});

describe("deleteProjectFromQdrantActivity — absent vs failed", () => {
	it("reports success without deleting when the organization's collection was never created", async () => {
		// Per-organization collections are created lazily on first write: an
		// organization that never embedded a project context has none, and
		// that must not stall the deletion (or the scheduled 7-day cleanup).
		mocks.qdrantGetCollections.mockResolvedValue(
			collectionsExisting(PERSONAL_COLLECTION),
		);

		const res = await deleteProjectFromQdrantActivity({
			projectId: "p1",
			organizationId: ORG_ID,
		});

		expect(res).toEqual({ success: true });
		expect(mocks.qdrantDelete).not.toHaveBeenCalled();
	});

	it("does NOT create the collection it resolves (existence stays observable)", async () => {
		mocks.qdrantGetCollections.mockResolvedValue(
			collectionsExisting(PERSONAL_COLLECTION),
		);

		await deleteProjectFromQdrantActivity({
			projectId: "p1",
			organizationId: ORG_ID,
		});

		// `ensureCollection` would have created it here; `getCollectionName`
		// must not. A created-on-delete collection makes "never existed"
		// permanently indistinguishable from "delete failed".
		expect(mocks.qdrantGetCollections).toHaveBeenCalled();
		expect(mocks.qdrantDelete).not.toHaveBeenCalled();
	});

	it("surfaces a vector-store failure against an existing collection instead of reporting success", async () => {
		mocks.qdrantDelete.mockRejectedValue(new Error("Qdrant unavailable"));

		await expect(
			deleteProjectFromQdrantActivity({
				projectId: "p1",
				organizationId: ORG_ID,
			}),
		).rejects.toThrow("Qdrant unavailable");
		expect(mocks.loggerError).toHaveBeenCalled();
	});

	it("surfaces a not-found error too, once the collection is known to exist", async () => {
		// The old classifier swallowed anything mentioning 404 / "not found"
		// as success — which is exactly how the mismatched collection name
		// stayed invisible. With existence confirmed first, that string no
		// longer buys a success.
		mocks.qdrantDelete.mockRejectedValue(
			new Error("Not found: collection does not exist (404)"),
		);

		await expect(
			deleteProjectFromQdrantActivity({
				projectId: "p1",
				organizationId: ORG_ID,
			}),
		).rejects.toThrow("Not found");
	});

	it("surfaces an unreachable vector store rather than treating it as empty", async () => {
		mocks.qdrantGetCollections.mockRejectedValue(
			new Error("ECONNREFUSED 6333"),
		);

		await expect(
			deleteProjectFromQdrantActivity({ projectId: "p1" }),
		).rejects.toThrow("ECONNREFUSED");
		expect(mocks.qdrantDelete).not.toHaveBeenCalled();
	});
});

describe("no hardcoded collection name at either site", () => {
	it.each([
		["project-deletion.ts", "../project-deletion.ts"],
		["project-contexts-reprocess.ts", "../project-contexts-reprocess.ts"],
	])(
		"%s resolves the collection instead of naming it",
		(_label, relativePath) => {
			const source = readFileSync(
				new URL(relativePath, import.meta.url),
				"utf8",
			);

			// Only the comment naming the defect may mention the old form, and
			// neither file needs to: assert the literal is gone entirely.
			expect(source).not.toContain(`"${LEGACY_UNDERSCORE_COLLECTION}"`);
			expect(source).toContain("getCollectionName(");
			// `ensureCollection` creates what it resolves — never on a delete path.
			expect(source).not.toContain("ensureCollection(");
		},
	);
});

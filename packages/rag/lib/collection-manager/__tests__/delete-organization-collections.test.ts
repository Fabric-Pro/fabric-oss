/**
 * `deleteOrganizationCollections` (Fizzy #2791).
 *
 * Organization teardown used a hand-maintained list of base collections that
 * had drifted from `BaseCollectionName`: `fabric_episodic_memory` was missing,
 * so a deleted organization's episode summaries stayed in Qdrant. It also
 * trusted a five-minute cached existence check and swallowed per-collection
 * failures, so the workflow's orphaned-vector alert could never fire.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCollectionsMock, deleteCollectionMock, createCollectionMock } =
	vi.hoisted(() => ({
		getCollectionsMock: vi.fn(),
		deleteCollectionMock: vi.fn(),
		createCollectionMock: vi.fn(),
	}));

vi.mock("../../vector-store/client", () => ({
	qdrantClient: {
		getCollections: getCollectionsMock,
		deleteCollection: deleteCollectionMock,
		createCollection: createCollectionMock,
	},
	DISTANCE_METRIC: "Cosine",
	VECTOR_SIZE: 1536,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { BaseCollectionName } from "../index";
import { deleteOrganizationCollections, ensureCollection } from "../index";

const ORG_ID = "org-1";

// Every member of `BaseCollectionName`. The `satisfies` clause plus the
// exhaustiveness check below fail type-check if a member is added or removed
// without updating this list.
const ALL_BASE_COLLECTIONS = [
	"chat-documents",
	"workspace-documents",
	"project-contexts",
	"fabric_orchestrator_memory",
	"fabric_episodic_memory",
	"fabric_capabilities",
] as const satisfies readonly BaseCollectionName[];
type Missing = Exclude<
	BaseCollectionName,
	(typeof ALL_BASE_COLLECTIONS)[number]
>;
const exhaustive: [Missing] extends [never] ? true : Missing = true;
void exhaustive;

const orgCollectionNames = ALL_BASE_COLLECTIONS.map(
	(base) => `${base}-org-${ORG_ID}`,
);

function qdrantHas(names: string[]) {
	getCollectionsMock.mockResolvedValue({
		collections: names.map((name) => ({ name })),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	deleteCollectionMock.mockResolvedValue(true);
});

describe("deleteOrganizationCollections", () => {
	it("drops the organization's collection for every base collection type", async () => {
		qdrantHas(orgCollectionNames);

		await deleteOrganizationCollections(ORG_ID);

		const deleted = deleteCollectionMock.mock.calls.map(([name]) => name);
		expect(deleted.sort()).toEqual([...orgCollectionNames].sort());
		expect(deleted).toContain(`fabric_episodic_memory-org-${ORG_ID}`);
	});

	it("skips collections the organization never created", async () => {
		qdrantHas([`project-contexts-org-${ORG_ID}`, "project-contexts"]);

		await deleteOrganizationCollections(ORG_ID);

		expect(deleteCollectionMock).toHaveBeenCalledTimes(1);
		expect(deleteCollectionMock).toHaveBeenCalledWith(
			`project-contexts-org-${ORG_ID}`,
		);
	});

	it("never touches personal or other organizations' collections", async () => {
		qdrantHas([
			...ALL_BASE_COLLECTIONS,
			...ALL_BASE_COLLECTIONS.map((base) => `${base}-org-org-2`),
		]);

		await deleteOrganizationCollections(ORG_ID);

		expect(deleteCollectionMock).not.toHaveBeenCalled();
	});

	it("asks Qdrant directly instead of trusting a cached 'missing' answer", async () => {
		// Seed a stale negative cache entry: `ensureCollection` caches the
		// collection as missing, then its create attempt fails. The collection
		// is one the old hand-written list already covered, so only the cached
		// existence check can make this test fail.
		qdrantHas([]);
		createCollectionMock.mockRejectedValueOnce(new Error("create failed"));
		await expect(
			ensureCollection("chat-documents", ORG_ID),
		).rejects.toThrow();

		// Another process has since created it.
		qdrantHas([`chat-documents-org-${ORG_ID}`]);
		await deleteOrganizationCollections(ORG_ID);

		expect(deleteCollectionMock).toHaveBeenCalledWith(
			`chat-documents-org-${ORG_ID}`,
		);
	});

	it("reports a deletion Qdrant did not confirm", async () => {
		qdrantHas([`project-contexts-org-${ORG_ID}`]);
		deleteCollectionMock.mockResolvedValue(false);

		await expect(deleteOrganizationCollections(ORG_ID)).rejects.toThrow(
			`project-contexts-org-${ORG_ID}`,
		);
	});

	it("attempts every collection, then reports the ones it could not delete", async () => {
		qdrantHas(orgCollectionNames);
		deleteCollectionMock.mockImplementation(async (name: string) => {
			if (name === `chat-documents-org-${ORG_ID}`) {
				throw new Error("qdrant unavailable");
			}
			return true;
		});

		await expect(deleteOrganizationCollections(ORG_ID)).rejects.toThrow(
			`chat-documents-org-${ORG_ID}`,
		);
		expect(deleteCollectionMock).toHaveBeenCalledTimes(
			orgCollectionNames.length,
		);
	});

	it("reports a failed existence check instead of treating it as empty", async () => {
		getCollectionsMock.mockRejectedValue(new Error("qdrant unreachable"));

		await expect(deleteOrganizationCollections(ORG_ID)).rejects.toThrow(
			/Failed to delete 6 collection/,
		);
		expect(deleteCollectionMock).not.toHaveBeenCalled();
	});

	it("rejects a malformed organization id before touching Qdrant", async () => {
		await expect(deleteOrganizationCollections("org/../x")).rejects.toThrow(
			/Invalid organization ID/,
		);
		expect(getCollectionsMock).not.toHaveBeenCalled();
	});
});

import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	count: vi.fn().mockResolvedValue({ count: 0 }),
	search: vi.fn().mockResolvedValue([]),
	query: vi.fn().mockResolvedValue({ points: [] }),
	delete: vi.fn().mockResolvedValue({}),
	scroll: vi.fn().mockResolvedValue({ points: [], next_page_offset: null }),
}));
vi.mock("../../vector-store/client", () => ({
	qdrantClient: h,
	VECTOR_SIZE: 1536,
	DISTANCE_METRIC: "Cosine",
}));
vi.mock("../client", () => ({ qdrantClient: h }));
vi.mock("../../collection-manager", async (original) => ({
	...(await original<typeof import("../../collection-manager")>()),
	ensureCollection: vi.fn().mockResolvedValue("project-contexts"),
	getCollectionName: vi.fn().mockReturnValue("project-contexts"),
	collectionExistsUncached: vi.fn().mockResolvedValue(true),
	getCollectionLayout: vi
		.fn()
		.mockResolvedValue({ supportsHybrid: false, denseVectorName: null }),
}));

vi.mock("@repo/database", () => ({
	getProjectCodeIndexes: vi.fn().mockResolvedValue([{ status: "READY" }]),
}));
vi.mock("../../embedding", () => ({
	generateQueryEmbedding: vi.fn().mockResolvedValue({ embedding: [1] }),
}));

import { COLLECTION_CONFIGS } from "../../collection-manager";
import * as wizard from "../../wizard-contexts/store";
import { searchProjectCodeIndex } from "../code-search";
import * as store from "../store";

function keys(value: unknown): string[] {
	if (!value || typeof value !== "object") {
		return [];
	}
	return Object.entries(value).flatMap(([key, child]) =>
		key === "key" && typeof child === "string" ? [child] : keys(child),
	);
}

it("indexes every payload key the rag project-context store functions filter on", async () => {
	await store.searchSimilarProjectContexts({
		projectId: "example-project",
		userId: "example-user",
		queryEmbedding: [1],
		contextIds: ["example-context"],
		excludeDocumentChunks: true,
	});
	await store.deleteProjectContext("example-context");
	await store.listProjectContextPointIds("example-context");
	await store.deleteStaleDocumentEmbeddingChunks({
		documentId: "example-document",
		currentVersion: 2,
	});
	for (const repository of [null, "example-repository"]) {
		await store.deleteProjectCodeIndexVectors(
			"example-project",
			"example-org",
			repository,
		);
		await store.deleteProjectCodeIndexVectorsForPaths(
			"example-project",
			"example-org",
			["example.ts"],
			repository,
		);
	}
	await store.deleteUrlSourceChunks("example-parent", "example-org");
	await store.deleteAllProjectContexts("example-project", "example-org");
	await store.deleteOrphanProjectContextPoints({
		projectId: "example-project",
		organizationId: "example-org",
		liveIds: new Set(["example-context"]),
	});
	await store.scrollProjectChunks({
		projectId: "example-project",
		maxPoints: 10,
	});
	await searchProjectCodeIndex({
		projectId: "example-project",
		userId: "example-user",
		query: "example",
	});
	const wizardInput = {
		sessionId: "example-session",
		userId: "example-user",
		organizationId: "example-org",
	};
	await wizard.searchWizardContexts({
		...wizardInput,
		queryEmbedding: [1],
		contextIds: ["example-context"],
	});
	await wizard.bindWizardEmbeddingsToProject({
		...wizardInput,
		projectId: "example-project",
		contextIdMapping: new Map([["example-temp", "example-context"]]),
	});
	await wizard.deleteWizardContext({
		...wizardInput,
		contextId: "example-context",
	});
	await wizard.deleteAllWizardContextsForSession(wizardInput);
	const used = new Set(
		Object.values(h).flatMap((mock) =>
			mock.mock.calls.flatMap((call) => keys(call[1])),
		),
	);
	expect([...used].sort()).toEqual([
		"contextId",
		"contextType",
		"documentId",
		"documentVersion",
		"filePath",
		"isWizardContext",
		"organizationId",
		"originalContextId",
		"parentContextId",
		"projectId",
		"repositoryIntegrationId",
		"sessionId",
		"userId",
	]);
	const indexed = new Set(
		COLLECTION_CONFIGS["project-contexts"].payloadIndexes.map(
			(index) => index.fieldName,
		),
	);
	expect([...used].filter((key) => !indexed.has(key))).toEqual([]);
});

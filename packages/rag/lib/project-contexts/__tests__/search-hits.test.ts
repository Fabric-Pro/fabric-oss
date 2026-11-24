import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	rows: vi.fn(),
	pages: vi.fn(),
	context: vi.fn(),
	bundle: vi.fn(),
	confidential: vi.fn(),
	folderGuidance: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		projectContext: { findMany: h.rows },
		projectContextUrlPage: { findMany: h.pages },
	},
	findConfidentialTranscriptContextIds: h.confidential,
	getRetrievableContextById: h.context,
	getRetrievableConversationBundleById: h.bundle,
	withInheritedSourceGuidance: h.folderGuidance,
}));
vi.mock("../store", () => ({
	searchSimilarProjectContexts: vi.fn(async () => []),
}));
vi.mock("../../embedding/sparse", () => ({ generateSparseVector: vi.fn() }));

import { generateSparseVector } from "../../embedding/sparse";
import {
	hydrateProjectContextHits,
	searchProjectContextHits,
	withoutConfidentialTranscripts,
} from "../search-hits";
import { searchSimilarProjectContexts } from "../store";

const tenant = {
	projectId: "example-project",
	userId: "example-user",
	organizationId: "example-org",
};
const hit = (contextId: string) => ({
	contextId,
	projectId: tenant.projectId,
	score: 0.9,
	type: "LINK",
});
const records = [
	{
		id: "own-page",
		project: {
			id: tenant.projectId,
			userId: "another-member",
			organizationId: tenant.organizationId,
		},
	},
	{
		id: "foreign-org",
		project: {
			id: tenant.projectId,
			userId: tenant.userId,
			organizationId: "other-org",
		},
	},
	{
		id: "foreign-project",
		project: {
			id: "other-project",
			userId: tenant.userId,
			organizationId: tenant.organizationId,
		},
	},
	{
		id: "personal-page",
		project: {
			id: tenant.projectId,
			userId: tenant.userId,
			organizationId: null,
		},
	},
	{
		id: "foreign-user",
		project: {
			id: tenant.projectId,
			userId: "other-user",
			organizationId: null,
		},
	},
	{
		id: "unrequested-page",
		project: {
			id: tenant.projectId,
			userId: tenant.userId,
			organizationId: tenant.organizationId,
		},
	},
];

/** Model the database helper: folder files without guidance take their folder's. */
const folderDescriptions = new Map<string, string>();
const optOut = { inheritFolderGuidance: false };

beforeEach(() => {
	vi.clearAllMocks();
	folderDescriptions.clear();
	h.folderGuidance.mockImplementation(
		async ({
			rows,
		}: {
			rows: Array<{ id: string; aiInstructions?: string | null }>;
		}) =>
			rows.map((row) =>
				!row.aiInstructions && folderDescriptions.has(row.id)
					? { ...row, aiInstructions: folderDescriptions.get(row.id) }
					: row,
			),
	);
	h.rows.mockResolvedValue([]);
	h.context.mockImplementation(async (id) => ({
		id,
		content: `body of ${id}`,
		type: "LINK",
	}));
	// Model the DB's conjunction rather than returning canned accepted ids.
	h.pages.mockImplementation(async ({ where }) =>
		records.filter((page) => {
			const project = where.parentContext?.project ?? {};
			return (
				(!where.id || where.id.in.includes(page.id)) &&
				Object.entries(project).every(
					([key, value]) =>
						page.project[key as keyof typeof page.project] ===
						value,
				)
			);
		}),
	);
});

describe("withoutConfidentialTranscripts", () => {
	it("drops every chunk of a confidential series' transcript and keeps the rest in order", async () => {
		h.confidential.mockResolvedValue(new Set(["transcript-secret"]));
		const hits = [
			hit("prd"),
			hit("transcript-secret"),
			hit("transcript-secret-chunk-3"),
			hit("transcript-open"),
		];

		await expect(
			withoutConfidentialTranscripts(hits, tenant.projectId),
		).resolves.toEqual([hit("prd"), hit("transcript-open")]);
		expect(h.confidential).toHaveBeenCalledWith({
			projectId: tenant.projectId,
			contextIds: ["prd", "transcript-secret", "transcript-open"],
		});
	});

	it("returns the hits as they are when no series is confidential", async () => {
		h.confidential.mockResolvedValue(new Set());
		const hits = [hit("prd"), hit("transcript-open")];

		await expect(
			withoutConfidentialTranscripts(hits, tenant.projectId),
		).resolves.toBe(hits);
	});
});

describe("project-scoped URL-page hydration", () => {
	it("rejects other organizations, other projects, and unrequested page ids", async () => {
		const result = await hydrateProjectContextHits({
			...tenant,
			lookup: "project-scoped-batch",
			hits: [hit("own-page"), hit("foreign-org"), hit("foreign-project")],
		});
		expect(
			result.flatMap(({ context }) => (context ? [context.id] : [])),
		).toEqual(["own-page"]);
		expect(h.context.mock.calls).toEqual([["own-page", optOut]]);
		expect(h.pages.mock.calls[0][0].where).toEqual({
			id: { in: ["own-page", "foreign-org", "foreign-project"] },
			parentContext: {
				project: {
					id: tenant.projectId,
					organizationId: tenant.organizationId,
				},
			},
		});
	});

	it("rejects another user's personal page and organization-owned pages on the null-org arm", async () => {
		const result = await hydrateProjectContextHits({
			...tenant,
			organizationId: undefined,
			lookup: "project-scoped-batch",
			hits: [
				hit("personal-page"),
				hit("foreign-user"),
				hit("foreign-org"),
			],
		});
		expect(
			result.flatMap(({ context }) => (context ? [context.id] : [])),
		).toEqual(["personal-page"]);
		expect(h.context.mock.calls).toEqual([["personal-page", optOut]]);
		expect(h.pages.mock.calls[0][0].where.parentContext.project).toEqual({
			id: tenant.projectId,
			userId: tenant.userId,
			organizationId: null,
		});
	});

	it("keeps batch context rows inside the activity's existing project and tenant filter", async () => {
		await hydrateProjectContextHits({
			...tenant,
			hits: [hit("own-page")],
			lookup: "project-scoped-batch",
		});
		expect(h.rows.mock.calls[0][0].where).toEqual({
			id: { in: ["own-page"] },
			project: {
				id: tenant.projectId,
				organizationId: tenant.organizationId,
			},
		});
	});
});

describe("folder guidance", () => {
	const folderFile = (id: string, aiInstructions: string | null = null) => ({
		id,
		content: `body of ${id}`,
		type: "DOCUMENT",
		metadata: { provider: "onedrive-documents" },
		aiInstructions,
	});

	it("gives a batch-hydrated folder file its folder's description in one lookup", async () => {
		folderDescriptions.set("file-1", "Signed case studies");
		h.rows.mockResolvedValue([
			folderFile("file-1"),
			folderFile("file-2", "Only the 2026 pricing applies"),
		]);

		const result = await hydrateProjectContextHits({
			...tenant,
			lookup: "batch",
			hits: [hit("file-1"), hit("file-2")],
		});

		expect(result.map(({ context }) => context?.aiInstructions)).toEqual([
			"Signed case studies",
			"Only the 2026 pricing applies",
		]);
		expect(h.folderGuidance).toHaveBeenCalledTimes(1);
		expect(h.folderGuidance.mock.calls[0][0].projectId).toBe(
			tenant.projectId,
		);
	});

	it("resolves individually hydrated hits as one batch, not per id", async () => {
		folderDescriptions.set("file-1", "Signed case studies");
		h.context.mockImplementation(async (id: string) => folderFile(id));

		const result = await hydrateProjectContextHits({
			...tenant,
			hits: [hit("file-1"), hit("file-2")],
		});

		expect(result.map(({ context }) => context?.aiInstructions)).toEqual([
			"Signed case studies",
			null,
		]);
		expect(h.context.mock.calls).toEqual([
			["file-1", optOut],
			["file-2", optOut],
		]);
		expect(h.folderGuidance).toHaveBeenCalledTimes(1);
	});

	it("reads the folder's current description on every hydration", async () => {
		h.context.mockImplementation(async (id: string) => folderFile(id));
		const read = async () =>
			(
				await hydrateProjectContextHits({
					...tenant,
					hits: [hit("file-1")],
				})
			)[0]?.context?.aiInstructions;

		folderDescriptions.set("file-1", "Draft case studies");
		expect(await read()).toBe("Draft case studies");
		folderDescriptions.set("file-1", "Signed case studies");
		expect(await read()).toBe("Signed case studies");
		// Disconnected: the folder no longer lends its description.
		folderDescriptions.delete("file-1");
		expect(await read()).toBeNull();
	});

	it("leaves captured bundles out of the folder lookup", async () => {
		h.bundle.mockResolvedValue({
			id: "example-bundle",
			content: "Captured messages",
			type: "INTEGRATION",
		});

		await hydrateProjectContextHits({
			...tenant,
			hits: [
				{
					...hit("bundle-hit"),
					conversationBundleId: "example-bundle",
				},
			],
		});

		expect(h.folderGuidance.mock.calls[0][0].rows).toEqual([]);
	});
});

it("keeps the first hit and resolves captured bundles with project and tenant scope", async () => {
	h.bundle.mockResolvedValue({
		id: "example-bundle",
		content: "Captured messages",
		type: "INTEGRATION",
	});
	const bundle = {
		...hit("bundle-hit"),
		conversationBundleId: "example-bundle",
	};
	const result = await hydrateProjectContextHits({
		...tenant,
		hits: [bundle, { ...bundle, score: 0.1 }],
	});
	expect(result).toHaveLength(1);
	expect(result[0].hit.score).toBe(0.9);
	expect(h.bundle).toHaveBeenCalledWith({
		bundleId: "example-bundle",
		projectId: tenant.projectId,
		tenant: {
			userId: tenant.userId,
			organizationId: tenant.organizationId,
		},
	});
	expect(h.context).not.toHaveBeenCalled();
});

it("falls back on encoder errors for activities while retaining the main path's error contract", async () => {
	const error = new Error("encoder unavailable");
	vi.mocked(generateSparseVector).mockImplementation(() => {
		throw error;
	});
	const options = {
		...tenant,
		query: "launch",
		embedQuery: async () => [0.1],
	};
	await expect(searchProjectContextHits(options)).resolves.toEqual([]);
	expect(searchSimilarProjectContexts).toHaveBeenCalledWith({
		...tenant,
		queryEmbedding: [0.1],
		querySparseVector: undefined,
	});
	await expect(
		searchProjectContextHits({
			...options,
			fallbackOnSparseFailure: false,
		}),
	).rejects.toBe(error);
	expect(searchSimilarProjectContexts).toHaveBeenCalledTimes(1);
});

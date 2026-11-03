import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	rows: vi.fn(),
	pages: vi.fn(),
	context: vi.fn(),
	bundle: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		projectContext: { findMany: h.rows },
		projectContextUrlPage: { findMany: h.pages },
	},
	getRetrievableContextById: h.context,
	getRetrievableConversationBundleById: h.bundle,
}));
vi.mock("../store", () => ({
	searchSimilarProjectContexts: vi.fn(async () => []),
}));
vi.mock("../../embedding/sparse", () => ({ generateSparseVector: vi.fn() }));

import { generateSparseVector } from "../../embedding/sparse";
import {
	hydrateProjectContextHits,
	searchProjectContextHits,
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

beforeEach(() => {
	vi.clearAllMocks();
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
		expect(h.context.mock.calls).toEqual([["own-page"]]);
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
		expect(h.context.mock.calls).toEqual([["personal-page"]]);
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

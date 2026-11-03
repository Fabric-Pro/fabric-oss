/**
 * Saving RAG settings: a chunking change bumps the chunking version and
 * starts the project re-chunk under the project's own organization; a
 * retrieval-only change never re-chunks.
 */
import { call, os } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resetRefresh: vi.fn(),
	access: vi.fn(),
	upsert: vi.fn(),
	current: vi.fn(),
	save: vi.fn(),
	start: vi.fn(),
	resolveOrg: vi.fn(),
	ragSettings: vi.fn(),
	startUnindexed: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const actual = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/chunking")
	>("@repo/database/prisma/queries/projects/chunking");
	return {
		hasProjectAccess: mocks.access,
		upsertProjectRagSettings: mocks.upsert,
		getProjectChunkingSettings: mocks.current,
		saveProjectChunkingChange: mocks.save,
		isChunkingChange: actual.isChunkingChange,
		resetCodeIndexRefreshSchedule: mocks.resetRefresh,
		getProjectRagSettings: mocks.ragSettings,
	};
});
vi.mock("../../../lib/code-indexing-trigger", () => ({
	startCodeIndexingForUnindexedRepos: mocks.startUnindexed,
}));
vi.mock("@repo/rag", async () => {
	const { chunkProfilesConfigSchema } = await vi.importActual<
		typeof import("@repo/rag/lib/chunking/profiles")
	>("@repo/rag/lib/chunking/profiles");
	return { chunkProfilesConfigSchema };
});
vi.mock("../../../lib/project-organization", () => ({
	resolveProjectOrganizationId: mocks.resolveOrg,
}));
vi.mock("../../../lib/project-rechunk", () => ({
	startProjectRechunk: mocks.start,
}));
vi.mock("../../../../../orpc/procedures", () => ({
	tenantProtectedProcedure: os.$context<{ user: { id: string } }>(),
	// The permission middleware has its own tests; here it lets everyone in.
	requireProjectPermission: () =>
		os
			.$context<{ user: { id: string } }>()
			.middleware(({ next }) => next()),
	Permissions: {},
}));

import { updateRagSettingsProcedure } from "../update-rag-settings";

const context = { user: { id: "user-1" } };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveOrg.mockResolvedValue("org-of-project");
	mocks.ragSettings.mockResolvedValue({
		codeSearchMode: "CODE_SEARCH",
		topK: 50,
		rerankTopK: 10,
	});
	mocks.access.mockResolvedValue(true);
	mocks.upsert.mockResolvedValue({ projectId: "p1" });
	mocks.current.mockResolvedValue({
		chunkByContentType: false,
		chunkProfiles: null,
		chunkingVersion: 0,
		chunkSize: 3000,
		chunkOverlap: 500,
		splitMethod: "DOCUMENT",
	});
	mocks.save.mockResolvedValue({ chunkingVersion: 1 });
	mocks.start.mockResolvedValue({ runId: "run-1", workflowId: "wf" });
});

describe("updateRagSettingsProcedure", () => {
	it("does not re-chunk for a retrieval-only change", async () => {
		const result = await call(
			updateRagSettingsProcedure,
			{ projectId: "p1", topK: 20, chunkSize: 3000 },
			{ context },
		);
		expect(result.rechunk).toBeNull();
		expect(mocks.save).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("saves the toggle and starts the re-chunk under the project's organization", async () => {
		const result = await call(
			updateRagSettingsProcedure,
			{
				projectId: "p1",
				organizationId: "org-from-caller",
				chunkByContentType: true,
			},
			{ context },
		);
		expect(mocks.resolveOrg).toHaveBeenCalledWith("org-from-caller", "p1");
		expect(mocks.save).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				organizationId: "org-of-project",
				change: expect.objectContaining({ chunkByContentType: true }),
			}),
		);
		expect(mocks.start).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: "org-of-project",
			userId: "user-1",
			chunkingVersion: 1,
		});
		expect(result.rechunk).toMatchObject({ runId: "run-1" });
	});

	it("refuses a caller without access to the project before writing", async () => {
		mocks.access.mockResolvedValue(false);
		await expect(
			call(
				updateRagSettingsProcedure,
				{ projectId: "p1", chunkByContentType: true },
				{ context },
			),
		).rejects.toThrow(/access/);
		expect(mocks.upsert).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("saves rows for only the types someone changed and re-chunks", async () => {
		const chunkProfiles = {
			backlog: { profile: "items" as const, target: 1500 },
			prd: { standard: true as const },
		};
		const result = await call(
			updateRagSettingsProcedure,
			{ projectId: "p1", chunkProfiles },
			{ context },
		);
		expect(mocks.save).toHaveBeenCalledWith(
			expect.objectContaining({
				change: expect.objectContaining({ chunkProfiles }),
			}),
		);
		expect(result.rechunk).toMatchObject({ runId: "run-1" });
	});

	it("restarts the code index refresh schedule when its interval changes", async () => {
		const result = await call(
			updateRagSettingsProcedure,
			{ projectId: "p1", codeIndexRefreshInterval: "HOURLY" },
			{ context },
		);
		expect(mocks.upsert).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ codeIndexRefreshInterval: "HOURLY" }),
		);
		expect(mocks.resetRefresh).toHaveBeenCalledWith("p1");
		expect(result.rechunk).toBeNull();
	});

	it("rejects per-type tuning outside the profile limits", async () => {
		await expect(
			call(
				updateRagSettingsProcedure,
				{ projectId: "p1", chunkProfiles: { prd: { target: 10 } } },
				{ context },
			),
		).rejects.toThrow();
		expect(mocks.save).not.toHaveBeenCalled();
	});

	it("indexes the included repositories not indexed yet on a switch to RAG", async () => {
		await call(
			updateRagSettingsProcedure,
			{ projectId: "p1", codeSearchMode: "RAG" },
			{ context },
		);
		expect(mocks.startUnindexed).toHaveBeenCalledWith({
			projectId: "p1",
			userId: "user-1",
			organizationId: "org-of-project",
		});
	});

	it("starts no indexing when the project already uses RAG", async () => {
		mocks.ragSettings.mockResolvedValue({ codeSearchMode: "RAG" });
		await call(
			updateRagSettingsProcedure,
			{ projectId: "p1", codeSearchMode: "RAG" },
			{ context },
		);
		expect(mocks.startUnindexed).not.toHaveBeenCalled();
	});
});

it.each([
	{ topK: 2.5, rerankTopK: 1 },
	{ rerankTopK: 2.5 },
	{ topK: 5 },
	{ rerankTopK: 51 },
	{ topK: 20, rerankTopK: 21 },
])("rejects invalid retrieval limits %j", async (input) => {
	await expect(
		call(
			updateRagSettingsProcedure,
			{ projectId: "p1", ...input },
			{ context },
		),
	).rejects.toThrow();
	expect(mocks.upsert).not.toHaveBeenCalled();
});
it("persists the source limit and accepts 100 candidate chunks", async () => {
	await call(
		updateRagSettingsProcedure,
		{ projectId: "p1", topK: 100, rerankTopK: 50 },
		{ context },
	);
	expect(mocks.upsert).toHaveBeenCalledWith(
		"p1",
		expect.objectContaining({ topK: 100, rerankTopK: 50 }),
	);
});
it("compares a source-only update against stored candidates", async () => {
	mocks.ragSettings.mockResolvedValue({ topK: 10, rerankTopK: 5 });
	await expect(
		call(
			updateRagSettingsProcedure,
			{ projectId: "p1", rerankTopK: 11 },
			{ context },
		),
	).rejects.toThrow("Maximum sources returned");
});

it("allows unrelated updates when stored retrieval limits are inconsistent", async () => {
	mocks.ragSettings.mockResolvedValue({
		topK: 5,
		rerankTopK: 10,
		codeSearchMode: "CODE_SEARCH",
	});
	await call(
		updateRagSettingsProcedure,
		{ projectId: "p1", codeSearchMode: "OFF" },
		{ context },
	);
	expect(mocks.upsert).toHaveBeenCalledWith(
		"p1",
		expect.objectContaining({ codeSearchMode: "OFF" }),
	);
});
it("rejects a candidate-only update against the stored source limit", async () => {
	mocks.ragSettings.mockResolvedValue({
		topK: 5,
		rerankTopK: 10,
		codeSearchMode: "CODE_SEARCH",
	});
	await expect(
		call(
			updateRagSettingsProcedure,
			{ projectId: "p1", topK: 5 },
			{ context },
		),
	).rejects.toThrow("Maximum sources returned");
	expect(mocks.upsert).not.toHaveBeenCalled();
});

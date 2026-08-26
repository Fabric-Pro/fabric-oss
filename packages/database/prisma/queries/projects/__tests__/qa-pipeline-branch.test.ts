/**
 * QA pipeline branch override (per connected repo).
 *
 * The behaviour worth pinning: QA follows the repo's default branch until an
 * override is set, the override is kept OUT of `defaultBranch` (which also
 * drives code indexing), and the update is scoped by projectId so an
 * integration id from another project can't be retargeted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => ({
	dbMock: {
		projectRepositoryIntegration: {
			findMany: vi.fn(),
			updateMany: vi.fn(),
		},
	},
}));

vi.mock("../../../client", () => ({ db: dbMock }));

import {
	getProjectReposForPipelineSync,
	listProjectQaPipelineSources,
	setProjectRepoQaBranch,
} from "../../project-repository-integrations";

const baseRow = {
	id: "int1",
	provider: "GITHUB",
	repositoryUrl: "https://github.com/acme/app",
	repositoryOwner: "acme",
	repositoryName: "app",
	defaultBranch: "main",
	qaBranch: null as string | null,
	encryptedAccessToken: null,
	encryptedRefreshToken: null,
	tokenExpiresAt: null,
	updatedAt: new Date("2026-07-25T00:00:00Z"),
	encryptedPat: null,
	azureOrganization: null,
	authMethod: "PAT",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getProjectReposForPipelineSync", () => {
	it("syncs the repo default branch when no override is set", async () => {
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			{ ...baseRow, qaBranch: null },
		]);
		const [source] = await getProjectReposForPipelineSync("p1");
		expect(source.branch).toBe("main");
	});

	it("syncs the override branch when one is set", async () => {
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			{ ...baseRow, qaBranch: "develop" },
		]);
		const [source] = await getProjectReposForPipelineSync("p1");
		expect(source.branch).toBe("develop");
	});

	it("falls back to the default when the override is an empty string", async () => {
		// A blank stored value must not produce an empty ref — that would make
		// the provider fetch every branch instead of the intended one.
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			{ ...baseRow, qaBranch: "" },
		]);
		const [source] = await getProjectReposForPipelineSync("p1");
		expect(source.branch).toBe("main");
	});
});

describe("listProjectQaPipelineSources", () => {
	it("reports the effective branch and never returns credentials", async () => {
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			{
				id: "int1",
				provider: "GITLAB",
				repositoryOwner: "acme",
				repositoryName: "app",
				defaultBranch: "main",
				qaBranch: "release/2026-07",
			},
		]);
		const [source] = await listProjectQaPipelineSources({
			projectId: "p1",
		});

		expect(source.effectiveBranch).toBe("release/2026-07");
		expect(source.defaultBranch).toBe("main");
		// This list renders in the browser — a token must never ride along.
		expect(Object.keys(source)).not.toContain("encryptedPat");
		expect(Object.keys(source)).not.toContain("encryptedAccessToken");
		const selected =
			dbMock.projectRepositoryIntegration.findMany.mock.calls[0][0]
				.select;
		expect(selected.encryptedPat).toBeUndefined();
		expect(selected.encryptedAccessToken).toBeUndefined();
	});
});

describe("setProjectRepoQaBranch", () => {
	it("scopes the update by projectId so another project's repo can't be retargeted", async () => {
		dbMock.projectRepositoryIntegration.updateMany.mockResolvedValue({
			count: 1,
		});
		await setProjectRepoQaBranch({
			projectId: "p1",
			integrationId: "int1",
			qaBranch: "develop",
		});

		const where =
			dbMock.projectRepositoryIntegration.updateMany.mock.calls[0][0]
				.where;
		expect(where).toEqual({ id: "int1", projectId: "p1" });
	});

	it("stores null (not an empty string) when the override is cleared", async () => {
		dbMock.projectRepositoryIntegration.updateMany.mockResolvedValue({
			count: 1,
		});
		await setProjectRepoQaBranch({
			projectId: "p1",
			integrationId: "int1",
			qaBranch: "   ",
		});

		const data =
			dbMock.projectRepositoryIntegration.updateMany.mock.calls[0][0]
				.data;
		expect(data).toEqual({ qaBranch: null });
	});

	it("trims a pasted branch name", async () => {
		dbMock.projectRepositoryIntegration.updateMany.mockResolvedValue({
			count: 1,
		});
		await setProjectRepoQaBranch({
			projectId: "p1",
			integrationId: "int1",
			qaBranch: "  develop\n",
		});

		const data =
			dbMock.projectRepositoryIntegration.updateMany.mock.calls[0][0]
				.data;
		expect(data).toEqual({ qaBranch: "develop" });
	});

	it("reports no update when the integration belongs to another project", async () => {
		dbMock.projectRepositoryIntegration.updateMany.mockResolvedValue({
			count: 0,
		});
		const result = await setProjectRepoQaBranch({
			projectId: "p1",
			integrationId: "someone-elses",
			qaBranch: "develop",
		});
		expect(result.updated).toBe(false);
	});
});

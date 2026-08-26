/**
 * `getProjectRepositoryPipelineSyncHealth` joins a connected repository to its
 * `TestPipelineSyncState` row for the Settings ▸ Development page (card #2383).
 *
 * The join key (`derivePipelineSyncKey`, private to `../pipeline-results.ts`)
 * DUPLICATES `derivePlan`'s key computation in
 * `packages/temporal/src/activities/pipeline-results/sync-pipeline-results.ts`
 * — deliberately, since `@repo/database` cannot depend on `@repo/temporal`.
 * The fixtures below are the SAME example repo URLs
 * `sync-pipeline-results.test.ts` exercises (`Fabric/Test-Repo` for ADO,
 * `acme/store` for GitHub/GitLab), so a future change to either side's key
 * derivation that breaks the match is caught by comparing against the same
 * expected pipelineKey strings pinned there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => {
	const make = () => ({ findMany: vi.fn() });
	return {
		dbMock: {
			projectRepositoryIntegration: make(),
			testPipelineSyncState: make(),
		},
	};
});

vi.mock("../../../client", () => ({ db: dbMock }));

import { getProjectRepositoryPipelineSyncHealth } from "../pipeline-results";

const adoIntegration = (overrides: Record<string, unknown> = {}) => ({
	id: "int-ado",
	provider: "AZURE_DEVOPS" as const,
	repositoryOwner: "example-org",
	repositoryName: "Test-Repo",
	repositoryUrl: "https://dev.azure.com/example-org/Fabric/_git/Test-Repo",
	...overrides,
});

const githubIntegration = (overrides: Record<string, unknown> = {}) => ({
	id: "int-gh",
	provider: "GITHUB" as const,
	repositoryOwner: "acme",
	repositoryName: "store",
	repositoryUrl: "https://github.com/acme/store",
	...overrides,
});

const gitlabIntegration = (overrides: Record<string, unknown> = {}) => ({
	id: "int-gl",
	provider: "GITLAB" as const,
	repositoryOwner: "acme",
	repositoryName: "store",
	repositoryUrl: "https://gitlab.com/acme/store",
	...overrides,
});

const syncStateRow = (overrides: Record<string, unknown> = {}) => ({
	id: "state-1",
	provider: "azure-devops",
	pipelineKey: "Fabric/Test-Repo",
	lastFetchedAt: null,
	status: "FAILED",
	lastError: "Azure DevOps rejected the credential as invalid or expired.",
	lastErrorDetail: null,
	lastErrorKind: "CREDENTIAL_REJECTED",
	lastErrorAt: new Date("2026-08-16T00:00:00Z"),
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getProjectRepositoryPipelineSyncHealth", () => {
	it("joins an Azure DevOps repo to its sync-state row via the project segment (not owner/repo)", async () => {
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			adoIntegration(),
		]);
		dbMock.testPipelineSyncState.findMany.mockResolvedValue([
			syncStateRow({ pipelineKey: "Fabric/Test-Repo" }),
		]);

		const health = await getProjectRepositoryPipelineSyncHealth({
			projectId: "p1",
		});

		expect(health).toEqual([
			{
				integrationId: "int-ado",
				lastFetchedAt: null,
				status: "FAILED",
				lastError:
					"Azure DevOps rejected the credential as invalid or expired.",
				lastErrorKind: "CREDENTIAL_REJECTED",
			},
		]);
	});

	it("joins a GitHub repo to its sync-state row via owner/repo", async () => {
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			githubIntegration(),
		]);
		dbMock.testPipelineSyncState.findMany.mockResolvedValue([
			syncStateRow({
				provider: "github-actions",
				pipelineKey: "acme/store",
				status: "SUCCESS",
				lastError: null,
				lastErrorKind: null,
				lastFetchedAt: new Date("2026-08-16T00:00:00Z"),
			}),
		]);

		const health = await getProjectRepositoryPipelineSyncHealth({
			projectId: "p1",
		});

		expect(health).toEqual([
			{
				integrationId: "int-gh",
				lastFetchedAt: new Date("2026-08-16T00:00:00Z"),
				status: "SUCCESS",
				lastError: null,
				lastErrorKind: null,
			},
		]);
	});

	it("joins a GitLab repo to its sync-state row via owner/repo", async () => {
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			gitlabIntegration(),
		]);
		dbMock.testPipelineSyncState.findMany.mockResolvedValue([
			syncStateRow({
				provider: "gitlab-ci",
				pipelineKey: "acme/store",
				status: "FAILED",
				lastError:
					"GitLab authenticated the credential but refused this resource.",
				lastErrorKind: "PERMISSION_MISSING",
			}),
		]);

		const health = await getProjectRepositoryPipelineSyncHealth({
			projectId: "p1",
		});

		expect(health).toEqual([
			{
				integrationId: "int-gl",
				lastFetchedAt: null,
				status: "FAILED",
				lastError:
					"GitLab authenticated the credential but refused this resource.",
				lastErrorKind: "PERMISSION_MISSING",
			},
		]);
	});

	it("does NOT match an ADO repo's sync state to owner/repo (the fallback key, not the real one)", async () => {
		// Regression guard: `planFallbackKey` in the temporal source of truth
		// writes `owner/repo` ONLY when plan derivation itself fails. A row
		// still sitting under that fallback key must not be joined as if it
		// were this repo's real (project/repo) sync state.
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			adoIntegration(),
		]);
		dbMock.testPipelineSyncState.findMany.mockResolvedValue([
			syncStateRow({ pipelineKey: "example-org/Test-Repo" }),
		]);

		const health = await getProjectRepositoryPipelineSyncHealth({
			projectId: "p1",
		});

		expect(health).toEqual([]);
	});

	it("omits a repo with no sync-state row (never synced) rather than fabricating one", async () => {
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			githubIntegration(),
		]);
		dbMock.testPipelineSyncState.findMany.mockResolvedValue([]);

		const health = await getProjectRepositoryPipelineSyncHealth({
			projectId: "p1",
		});

		expect(health).toEqual([]);
	});

	it("omits a repo whose URL cannot be parsed when no row exists at either key", async () => {
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			adoIntegration({ repositoryUrl: "https://dev.azure.com/onlyorg" }),
		]);
		// This row sits at the normally-DERIVED key ("Fabric/Test-Repo"), which
		// is exactly what CANNOT be derived here (the URL has no project
		// segment) — so it must not match via either path.
		dbMock.testPipelineSyncState.findMany.mockResolvedValue([
			syncStateRow(),
		]);

		const health = await getProjectRepositoryPipelineSyncHealth({
			projectId: "p1",
		});

		expect(health).toEqual([]);
	});

	// Card #2383, finding 5: a plan-derivation failure (unparseable URL) is
	// recorded by `failSource` in sync-pipeline-results.ts under
	// `planFallbackKey(source)` — `${owner}/${repo}` under the source's
	// provider tag — because the REAL key could not be derived. Settings ▸
	// Development must show that failure too, using the SAME fallback key, or
	// the QA-tab banner's reconnect link leads to a page that shows the repo
	// as healthy.
	it("joins a repo whose URL cannot be parsed via the SAME owner/repo fallback key failSource writes under", async () => {
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			adoIntegration({ repositoryUrl: "https://dev.azure.com/onlyorg" }),
		]);
		dbMock.testPipelineSyncState.findMany.mockResolvedValue([
			syncStateRow({
				pipelineKey: "example-org/Test-Repo", // owner/repo — the fallback format
				status: "FAILED",
				lastError:
					"Could not determine the Azure DevOps org/project from the repo URL.",
				lastErrorKind: "MISCONFIGURED",
			}),
		]);

		const health = await getProjectRepositoryPipelineSyncHealth({
			projectId: "p1",
		});

		expect(health).toEqual([
			{
				integrationId: "int-ado",
				lastFetchedAt: null,
				status: "FAILED",
				lastError:
					"Could not determine the Azure DevOps org/project from the repo URL.",
				lastErrorKind: "MISCONFIGURED",
			},
		]);
	});

	it("prefers the normally-derived key over the fallback when the URL IS parseable", async () => {
		// Regression guard for the fallback itself: a repo whose URL parses
		// successfully must use its REAL key, never accidentally fall back —
		// the fallback is used ONLY when the real key can't be derived at all.
		dbMock.projectRepositoryIntegration.findMany.mockResolvedValue([
			adoIntegration(), // parseable → derives "Fabric/Test-Repo"
		]);
		dbMock.testPipelineSyncState.findMany.mockResolvedValue([
			syncStateRow({ pipelineKey: "example-org/Test-Repo" }), // fallback-shaped, stale
			syncStateRow({
				pipelineKey: "Fabric/Test-Repo",
				status: "SUCCESS",
			}),
		]);

		const health = await getProjectRepositoryPipelineSyncHealth({
			projectId: "p1",
		});

		expect(health).toEqual([
			expect.objectContaining({ status: "SUCCESS" }),
		]);
	});
});

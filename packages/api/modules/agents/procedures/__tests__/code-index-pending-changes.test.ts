/**
 * `agents.codeIndex.pendingChanges` — "N commits behind · M files changed" for a
 * connected repo, now provider-agnostic (GitHub / GitLab / Azure DevOps).
 *
 * Locks the contract:
 *   - no index row / placeholder commit / missing integration / no token / failed
 *     compare all degrade to `upToDate: null` (the UI omits the line).
 *   - a behind index reports aheadBy as the commit count, the changed-file COUNT,
 *     and the head SHA, for every provider (mocked compare).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.fn();
const mockGetProjectCodeIndexes = vi.fn();
const mockResolveFreshRepoToken = vi.fn();
const mockCompare = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			findFirst: (...a: unknown[]) => mockFindFirst(...a),
		},
	},
	getProjectCodeIndexes: (...a: unknown[]) => mockGetProjectCodeIndexes(...a),
}));

vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: (...a: unknown[]) => mockResolveFreshRepoToken(...a),
}));

vi.mock("../../../projects/lib/repo-compare", () => ({
	compareIndexedCommitToHead: (...a: unknown[]) => mockCompare(...a),
}));

vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: { id: string } };
}) => Promise<{
	upToDate: boolean | null;
	behindByCommits: number;
	changedFiles: number;
	aheadCommitSha?: string;
}>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../code-index-pending-changes");
	return (mod.getCodeIndexPendingChanges as unknown as { handler: Handler })
		.handler;
}

const input = {
	projectId: "p1",
	repositoryIntegrationId: "int-1",
	organizationId: null,
};
const context = { user: { id: "user-1" }, session: { id: "session-1" } };

function makeIndexRow(overrides: Record<string, unknown> = {}) {
	return {
		repositoryIntegrationId: "int-1",
		commitSha: "base-sha",
		branch: "main",
		indexedAt: new Date("2026-01-01T00:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetProjectCodeIndexes.mockResolvedValue([makeIndexRow()]);
	mockFindFirst.mockResolvedValue({
		provider: "GITLAB",
		repositoryOwner: "group",
		repositoryName: "widgets",
		repositoryUrl: "https://gitlab.com/group/widgets",
		azureOrganization: null,
	});
	mockResolveFreshRepoToken.mockResolvedValue({
		token: "tok",
		authMethod: "OAUTH",
		provider: "GITLAB",
	});
	mockCompare.mockResolvedValue({
		status: "ahead",
		aheadBy: 2,
		behindBy: 0,
		changedFiles: ["src/a.ts", "src/b.ts"],
		headSha: "head-sha",
		truncated: false,
	});
});

describe("getCodeIndexPendingChanges — degrade to unknown", () => {
	it("returns unknown when there is no index row", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue([]);
		const handler = await loadHandler();
		await expect(handler({ input, context })).resolves.toEqual({
			upToDate: null,
			behindByCommits: 0,
			changedFiles: 0,
		});
		expect(mockCompare).not.toHaveBeenCalled();
	});

	it("returns unknown when the indexed commit is still 'pending'", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue([
			makeIndexRow({ commitSha: "pending" }),
		]);
		const handler = await loadHandler();
		await expect(handler({ input, context })).resolves.toMatchObject({
			upToDate: null,
		});
	});

	it("returns unknown when the integration row is gone", async () => {
		mockFindFirst.mockResolvedValue(null);
		const handler = await loadHandler();
		await expect(handler({ input, context })).resolves.toMatchObject({
			upToDate: null,
		});
		expect(mockCompare).not.toHaveBeenCalled();
	});

	it("returns unknown when no token can be resolved", async () => {
		mockResolveFreshRepoToken.mockResolvedValue({
			token: null,
			authMethod: null,
			provider: null,
		});
		const handler = await loadHandler();
		await expect(handler({ input, context })).resolves.toMatchObject({
			upToDate: null,
		});
		expect(mockCompare).not.toHaveBeenCalled();
	});

	it("returns unknown when the compare fails", async () => {
		mockCompare.mockResolvedValue({
			status: "unknown",
			aheadBy: 0,
			behindBy: 0,
			changedFiles: [],
			headSha: null,
			truncated: false,
		});
		const handler = await loadHandler();
		await expect(handler({ input, context })).resolves.toMatchObject({
			upToDate: null,
		});
	});
});

describe("getCodeIndexPendingChanges — reports the diff (all providers)", () => {
	it("maps aheadBy → behind count, changed-file COUNT, and head SHA (GitLab)", async () => {
		const handler = await loadHandler();
		const result = await handler({ input, context });

		expect(mockCompare).toHaveBeenCalledWith(
			expect.objectContaining({
				token: "tok",
				base: "base-sha",
				head: "main",
				repo: expect.objectContaining({ provider: "GITLAB" }),
			}),
		);
		expect(result).toEqual({
			upToDate: false,
			behindByCommits: 2,
			changedFiles: 2,
			aheadCommitSha: "head-sha",
		});
	});

	it("reports up to date when the branch has no new commits", async () => {
		mockFindFirst.mockResolvedValue({
			provider: "AZURE_DEVOPS",
			repositoryOwner: "my-org",
			repositoryName: "widgets",
			repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/widgets",
			azureOrganization: "my-org",
		});
		mockCompare.mockResolvedValue({
			status: "identical",
			aheadBy: 0,
			behindBy: 0,
			changedFiles: [],
			headSha: null,
			truncated: false,
		});

		const handler = await loadHandler();
		const result = await handler({ input, context });
		expect(result).toEqual({
			upToDate: true,
			behindByCommits: 0,
			changedFiles: 0,
			aheadCommitSha: undefined,
		});
	});
});

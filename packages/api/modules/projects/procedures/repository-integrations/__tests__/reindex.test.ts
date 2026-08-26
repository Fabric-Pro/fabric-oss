/**
 * `projects.repositoryIntegrations.reindex` — manual re-index with a mode.
 *
 * Locks the external contract:
 *   - `mode: "full"` (default) rebuilds — no compare, incremental:false.
 *   - `mode: "incremental"` diffs the indexed commit → branch HEAD (all
 *     providers) and re-embeds only the changed files.
 *   - already up to date (0 changed) starts NO run and reports upToDate.
 *   - no baseline / no token / compare failed / truncated → falls back to a full
 *     index and reports fellBackToFull.
 *   - integration-not-found, disabled, and no-credentials still map to errors.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetProjectRepoIntegration = vi.fn();
const mockGetProjectCodeIndexes = vi.fn();
const mockResolveFreshRepoToken = vi.fn();
const mockStartCodeIndexing = vi.fn();
const mockCompare = vi.fn();
const capturedPermissions: unknown[] = [];

vi.mock("@repo/database", () => ({
	getProjectRepoIntegration: (...a: unknown[]) =>
		mockGetProjectRepoIntegration(...a),
	getProjectCodeIndexes: (...a: unknown[]) => mockGetProjectCodeIndexes(...a),
}));

vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: (...a: unknown[]) => mockResolveFreshRepoToken(...a),
}));

vi.mock("../../../lib/code-indexing-trigger", () => ({
	startCodeIndexingForProject: (...a: unknown[]) =>
		mockStartCodeIndexing(...a),
}));

vi.mock("../../../lib/repo-compare", () => ({
	compareIndexedCommitToHead: (...a: unknown[]) => mockCompare(...a),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: (permission: unknown) => {
			capturedPermissions.push(permission);
			return (c: unknown) => c;
		},
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: { id: string } };
}) => Promise<{
	success: boolean;
	started: number;
	upToDate: boolean;
	fellBackToFull: boolean;
}>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../reindex");
	return (
		mod.reindexRepoIntegrationProcedure as unknown as { handler: Handler }
	).handler;
}

function makeIntegration(overrides: Record<string, unknown> = {}) {
	return {
		id: "int-1",
		projectId: "p1",
		provider: "GITHUB",
		repositoryOwner: "acme",
		repositoryName: "widgets",
		repositoryUrl: "https://github.com/acme/widgets",
		azureOrganization: null,
		...overrides,
	};
}

function makeIndexRow(overrides: Record<string, unknown> = {}) {
	return {
		repositoryIntegrationId: "int-1",
		commitSha: "base-sha",
		branch: "main",
		indexedAt: new Date("2026-01-01T00:00:00Z"),
		...overrides,
	};
}

const baseContext = {
	user: { id: "user-1" },
	session: { id: "session-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockGetProjectRepoIntegration.mockResolvedValue(makeIntegration());
	mockGetProjectCodeIndexes.mockResolvedValue([makeIndexRow()]);
	mockResolveFreshRepoToken.mockResolvedValue({
		token: "tok",
		authMethod: "OAUTH",
		provider: "GITHUB",
	});
	mockStartCodeIndexing.mockResolvedValue({ started: 1, skipped: [] });
	mockCompare.mockResolvedValue({
		status: "ahead",
		aheadBy: 2,
		behindBy: 0,
		changedFiles: ["src/a.ts", "src/b.ts"],
		headSha: "head-sha",
		truncated: false,
	});
});

describe("reindexRepoIntegrationProcedure — full (default)", () => {
	it("rebuilds fully with no compare when mode is omitted", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "p1", integrationId: "int-1", mode: "full" },
			context: baseContext,
		});

		expect(mockCompare).not.toHaveBeenCalled();
		expect(mockStartCodeIndexing).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				repositoryIntegrationId: "int-1",
				incremental: false,
				changedFiles: undefined,
			}),
		);
		expect(result).toEqual({
			success: true,
			started: 1,
			upToDate: false,
			fellBackToFull: false,
		});
	});
});

describe("reindexRepoIntegrationProcedure — incremental", () => {
	it("compares the indexed commit → branch HEAD and re-embeds only changed files", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				integrationId: "int-1",
				mode: "incremental",
			},
			context: baseContext,
		});

		expect(mockCompare).toHaveBeenCalledWith(
			expect.objectContaining({
				token: "tok",
				base: "base-sha",
				head: "main",
				repo: expect.objectContaining({ provider: "GITHUB" }),
			}),
		);
		expect(mockStartCodeIndexing).toHaveBeenCalledWith(
			expect.objectContaining({
				incremental: true,
				changedFiles: ["src/a.ts", "src/b.ts"],
			}),
		);
		expect(result).toEqual({
			success: true,
			started: 1,
			upToDate: false,
			fellBackToFull: false,
		});
	});

	it("starts NO run and reports upToDate when there are no new commits", async () => {
		mockCompare.mockResolvedValue({
			status: "identical",
			aheadBy: 0,
			behindBy: 0,
			changedFiles: [],
			headSha: null,
			truncated: false,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				integrationId: "int-1",
				mode: "incremental",
			},
			context: baseContext,
		});

		expect(mockStartCodeIndexing).not.toHaveBeenCalled();
		expect(result).toEqual({
			success: true,
			started: 0,
			upToDate: true,
			fellBackToFull: false,
		});
	});

	it("falls back to a full index when there is no prior indexed commit", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue([]);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				integrationId: "int-1",
				mode: "incremental",
			},
			context: baseContext,
		});

		// No baseline → never even resolves a token or compares.
		expect(mockResolveFreshRepoToken).not.toHaveBeenCalled();
		expect(mockCompare).not.toHaveBeenCalled();
		expect(mockStartCodeIndexing).toHaveBeenCalledWith(
			expect.objectContaining({ incremental: false }),
		);
		expect(result.fellBackToFull).toBe(true);
	});

	it("falls back to a full index when the compare fails", async () => {
		mockCompare.mockResolvedValue({
			status: "unknown",
			aheadBy: 0,
			behindBy: 0,
			changedFiles: [],
			headSha: null,
			truncated: false,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				integrationId: "int-1",
				mode: "incremental",
			},
			context: baseContext,
		});

		expect(mockStartCodeIndexing).toHaveBeenCalledWith(
			expect.objectContaining({ incremental: false }),
		);
		expect(result.fellBackToFull).toBe(true);
	});

	it("falls back to a full index when the changed-file list is truncated", async () => {
		mockCompare.mockResolvedValue({
			status: "ahead",
			aheadBy: 400,
			behindBy: 0,
			changedFiles: ["src/a.ts"],
			headSha: "h",
			truncated: true,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				integrationId: "int-1",
				mode: "incremental",
			},
			context: baseContext,
		});

		expect(mockStartCodeIndexing).toHaveBeenCalledWith(
			expect.objectContaining({ incremental: false }),
		);
		expect(result.fellBackToFull).toBe(true);
	});

	it("falls back to a full index when no token can be resolved", async () => {
		mockResolveFreshRepoToken.mockResolvedValue({
			token: null,
			authMethod: null,
			provider: null,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				integrationId: "int-1",
				mode: "incremental",
			},
			context: baseContext,
		});

		expect(mockCompare).not.toHaveBeenCalled();
		expect(result.fellBackToFull).toBe(true);
	});
});

describe("reindexRepoIntegrationProcedure — errors", () => {
	it("throws NOT_FOUND when the integration is not in the project", async () => {
		mockGetProjectRepoIntegration.mockResolvedValue(null);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					integrationId: "int-x",
					mode: "full",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			message: "Repository integration not found",
		});
		expect(mockStartCodeIndexing).not.toHaveBeenCalled();
	});

	it("throws when code indexing is disabled for the environment", async () => {
		mockStartCodeIndexing.mockResolvedValue({
			started: 0,
			skipped: [],
			disabledReason: "feature-flag",
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					integrationId: "int-1",
					mode: "full",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			message: "Code indexing is not enabled for this environment",
		});
	});

	it("throws when no repository can be started (no credentials)", async () => {
		mockStartCodeIndexing.mockResolvedValue({ started: 0, skipped: [] });

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					integrationId: "int-1",
					mode: "full",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			message:
				"No usable credentials for this repository — reconnect it and try again",
		});
	});

	it("is registered behind the PROJECT_SETTINGS_EDIT permission", async () => {
		await loadHandler();
		expect(capturedPermissions).toContain("PROJECT_SETTINGS_EDIT");
	});
});

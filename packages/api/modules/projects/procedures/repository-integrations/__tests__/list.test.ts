import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHasProjectAccess = vi.fn();
const mockListProjectRepoIntegrations = vi.fn();
const mockGetProjectCodeIndexes = vi.fn();

vi.mock("@repo/database", async () => ({
	...(await vi.importActual<
		typeof import("@repo/database/src/code-index-cancel")
	>("@repo/database/src/code-index-cancel")),
	hasProjectAccess: (...a: unknown[]) => mockHasProjectAccess(...a),
	listProjectRepoIntegrations: (...a: unknown[]) =>
		mockListProjectRepoIntegrations(...a),
	getProjectCodeIndexes: (...a: unknown[]) => mockGetProjectCodeIndexes(...a),
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
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { listRepoIntegrationsProcedure } from "../list";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: Record<string, unknown> };
}) => Promise<{
	integrations: Array<{
		id: string;
		codeIndex: Record<string, unknown> | null;
	}>;
	hasLegacyIndexRecord: boolean;
}>;

function getHandler(): Handler {
	return (listRepoIntegrationsProcedure as unknown as { handler: Handler })
		.handler;
}

describe("listRepoIntegrationsProcedure", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockHasProjectAccess.mockResolvedValue(true);
	});

	it("maps per-repo codeIndex and reports hasLegacyIndexRecord: false for clean repos", async () => {
		mockListProjectRepoIntegrations.mockResolvedValue([
			{ id: "repo-1", repositoryOwner: "acme", repositoryName: "app-1" },
			{ id: "repo-2", repositoryOwner: "acme", repositoryName: "app-2" },
		]);
		mockGetProjectCodeIndexes.mockResolvedValue([
			{
				repositoryIntegrationId: "repo-1",
				status: "READY",
				branch: "main",
				commitSha: "abc1234",
				indexedAt: new Date("2026-08-01"),
				filesIndexed: 10,
				chunksCreated: 20,
			},
		]);

		const handler = getHandler();
		const result = await handler({
			input: { projectId: "proj-1" },
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(result.hasLegacyIndexRecord).toBe(false);
		expect(result.integrations[0].codeIndex).toEqual(
			expect.objectContaining({
				status: "READY",
				branch: "main",
			}),
		);
		expect(result.integrations[1].codeIndex).toBeNull();
	});

	it("marks a user-cancelled index as cancelled without exposing its error", async () => {
		mockListProjectRepoIntegrations.mockResolvedValue([
			{ id: "repo-1", repositoryOwner: "acme", repositoryName: "app-1" },
			{ id: "repo-2", repositoryOwner: "acme", repositoryName: "app-2" },
		]);
		mockGetProjectCodeIndexes.mockResolvedValue([
			{
				repositoryIntegrationId: "repo-1",
				status: "FAILED",
				error: "Cancelled by user",
			},
			{
				repositoryIntegrationId: "repo-2",
				status: "FAILED",
				error: "Embedding provider unavailable",
			},
		]);

		const result = await getHandler()({
			input: { projectId: "proj-1" },
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(result.integrations[0].codeIndex).toEqual(
			expect.objectContaining({ status: "FAILED", cancelled: true }),
		);
		expect(result.integrations[1].codeIndex).toEqual(
			expect.objectContaining({ status: "FAILED", cancelled: false }),
		);
		expect(result.integrations[0].codeIndex).not.toHaveProperty("error");
	});

	it("flags hasLegacyIndexRecord: true when a legacy null-keyed index record exists", async () => {
		mockListProjectRepoIntegrations.mockResolvedValue([
			{ id: "repo-1", repositoryOwner: "acme", repositoryName: "app-1" },
			{ id: "repo-2", repositoryOwner: "acme", repositoryName: "app-2" },
		]);
		mockGetProjectCodeIndexes.mockResolvedValue([
			{
				repositoryIntegrationId: null,
				status: "READY",
				branch: "main",
				commitSha: "legacy123",
				indexedAt: new Date("2026-07-01"),
			},
		]);

		const handler = getHandler();
		const result = await handler({
			input: { projectId: "proj-1" },
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(result.hasLegacyIndexRecord).toBe(true);
		// Per-repo codeIndex remains null (does NOT fake or fan out legacy index onto un-indexed repos)
		expect(result.integrations[0].codeIndex).toBeNull();
		expect(result.integrations[1].codeIndex).toBeNull();
	});
});

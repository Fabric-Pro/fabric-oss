/**
 * `projects.repositoryIntegrations.cancelReindex` finalizes an INDEXING row with
 * the shared cancel marker, so the repository list can report it as cancelled
 * rather than failed.
 */

import { CODE_INDEX_CANCELLED_ERROR } from "@repo/database/src/code-index-cancel";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetProjectRepoIntegration = vi.fn();
const mockGetProjectCodeIndexes = vi.fn();
const mockUpdateCodeIndexStatus = vi.fn();
const mockCancelCodeIndexing = vi.fn();

vi.mock("@repo/database", async () => ({
	...(await vi.importActual<
		typeof import("@repo/database/src/code-index-cancel")
	>("@repo/database/src/code-index-cancel")),
	getProjectRepoIntegration: (...a: unknown[]) =>
		mockGetProjectRepoIntegration(...a),
	getProjectCodeIndexes: (...a: unknown[]) => mockGetProjectCodeIndexes(...a),
	updateCodeIndexStatus: (...a: unknown[]) => mockUpdateCodeIndexStatus(...a),
}));

vi.mock("../../../lib/code-indexing-trigger", () => ({
	cancelCodeIndexingForRepo: (...a: unknown[]) =>
		mockCancelCodeIndexing(...a),
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
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { cancelReindexRepoIntegrationProcedure } from "../cancel-reindex";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<{ success: boolean }>;
const cancelReindex = (
	cancelReindexRepoIntegrationProcedure as unknown as { handler: Handler }
).handler;

const input = { projectId: "proj-1", integrationId: "int-1" };

beforeEach(() => {
	vi.resetAllMocks();
	mockGetProjectRepoIntegration.mockResolvedValue({ id: "int-1" });
	mockCancelCodeIndexing.mockResolvedValue(undefined);
});

describe("cancelReindex", () => {
	it("finalizes an INDEXING row as FAILED with the shared cancel marker", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue([
			{
				repositoryIntegrationId: "int-1",
				branch: "main",
				status: "INDEXING",
			},
		]);

		await expect(cancelReindex({ input, context: {} })).resolves.toEqual({
			success: true,
		});
		expect(mockUpdateCodeIndexStatus).toHaveBeenCalledWith(
			{
				projectId: "proj-1",
				repositoryIntegrationId: "int-1",
				branch: "main",
			},
			"FAILED",
			CODE_INDEX_CANCELLED_ERROR,
		);
	});

	it("leaves a row that is no longer indexing untouched", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue([
			{
				repositoryIntegrationId: "int-1",
				branch: "main",
				status: "READY",
			},
		]);

		await cancelReindex({ input, context: {} });
		expect(mockUpdateCodeIndexStatus).not.toHaveBeenCalled();
	});
});

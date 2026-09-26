/**
 * `projects.pipelineResults.syncRun` — whether the exact Temporal run `sync`
 * started or joined has closed (Fizzy #2722, #2723 design). Anchoring
 * completion to this run, not to a sync-state row's `updatedAt`, is the whole
 * point: a row another writer touched must not read as "this sync finished".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetHandle = vi.fn();
const mockGetTemporalClient = vi.fn();

vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...a: unknown[]) => mockGetTemporalClient(...a),
}));

vi.mock("../../../lib/pipeline-results-feature", () => ({
	assertPipelineResultsEnabled: () => undefined,
}));

const capturedPermissions: unknown[] = [];

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
		requireProjectPermission: (permission: unknown) => {
			capturedPermissions.push(permission);
			return (c: unknown) => c;
		},
	};
});

const { syncRunStateProcedure } = await import("../sync-run");

function describeRun(input: { projectId: string; runId: string }) {
	return (
		syncRunStateProcedure as unknown as {
			handler: (a: { input: unknown }) => Promise<{ state: string }>;
		}
	).handler({ input });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetTemporalClient.mockResolvedValue({
		workflow: { getHandle: mockGetHandle },
	});
});

describe("syncRunStateProcedure", () => {
	it("is read-gated by TEST_CASE_READ", () => {
		expect(capturedPermissions).toContain("TEST_CASE_READ");
	});

	it("describes the exact workflow id derived from the projectId, and the given runId", async () => {
		const describeFn = vi
			.fn()
			.mockResolvedValue({ status: { name: "RUNNING" } });
		mockGetHandle.mockReturnValue({ describe: describeFn });

		await describeRun({ projectId: "p1", runId: "run-abc" });

		expect(mockGetHandle).toHaveBeenCalledWith(
			"pipeline-results-sync-p1",
			"run-abc",
		);
	});

	it("reports running while Temporal describes the run as RUNNING", async () => {
		mockGetHandle.mockReturnValue({
			describe: async () => ({ status: { name: "RUNNING" } }),
		});

		await expect(
			describeRun({ projectId: "p1", runId: "run-1" }),
		).resolves.toEqual({ state: "running" });
	});

	it.each(["COMPLETED", "FAILED", "CANCELLED", "TERMINATED"])(
		"reports closed for a %s run",
		async (status) => {
			mockGetHandle.mockReturnValue({
				describe: async () => ({ status: { name: status } }),
			});

			await expect(
				describeRun({ projectId: "p1", runId: "run-1" }),
			).resolves.toEqual({ state: "closed" });
		},
	);

	it("reports closed when Temporal no longer has the run — long over, never still running", async () => {
		const notFound = Object.assign(new Error("gone"), {
			name: "WorkflowNotFoundError",
		});
		mockGetHandle.mockReturnValue({
			describe: async () => {
				throw notFound;
			},
		});

		await expect(
			describeRun({ projectId: "p1", runId: "run-1" }),
		).resolves.toEqual({ state: "closed" });
	});

	it("reports unknown for an unrecognized status — never read as closed", async () => {
		mockGetHandle.mockReturnValue({
			describe: async () => ({ status: { name: "UNSPECIFIED" } }),
		});

		await expect(
			describeRun({ projectId: "p1", runId: "run-1" }),
		).resolves.toEqual({ state: "unknown" });
	});

	it("reports unknown when the describe call fails for any other reason", async () => {
		mockGetHandle.mockReturnValue({
			describe: async () => {
				throw new Error("connection reset");
			},
		});

		await expect(
			describeRun({ projectId: "p1", runId: "run-1" }),
		).resolves.toEqual({ state: "unknown" });
	});

	it("reports unknown when the describe call outlives its timeout — never closed", async () => {
		vi.useFakeTimers();
		mockGetHandle.mockReturnValue({
			describe: () => new Promise(() => {}),
		});

		const pending = describeRun({ projectId: "p1", runId: "run-1" });
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(pending).resolves.toEqual({ state: "unknown" });
		vi.useRealTimers();
	});
});

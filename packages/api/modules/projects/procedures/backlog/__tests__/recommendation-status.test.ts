/**
 * `backlog.recommendationStatus` (Fizzy #2208): one case per run state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;

const captured = vi.hoisted((): { handler: Handler | null } => ({
	handler: null,
}));

const mocks = vi.hoisted(() => ({
	getHandle: vi.fn(),
	describe: vi.fn(),
	query: vi.fn(),
	result: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { getHandle: mocks.getHandle },
	})),
	roadmapRecommendationProgressQuery: "roadmapRecommendationProgress",
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder = {
		use: vi.fn(),
		route: vi.fn(),
		input: vi.fn(),
		output: vi.fn(),
		handler: vi.fn((fn: Handler) => {
			captured.handler = fn;
			return builder;
		}),
	};
	builder.use.mockReturnValue(builder);
	builder.route.mockReturnValue(builder);
	builder.input.mockReturnValue(builder);
	builder.output.mockReturnValue(builder);
	return {
		Permissions: { PROJECT_READ: "PROJECT_READ" },
		requireProjectPermission: vi.fn(() => vi.fn()),
		tenantProtectedProcedure: builder,
	};
});

await import("../recommendation-status");

function call() {
	if (!captured.handler) {
		throw new Error("handler was not captured");
	}
	return captured.handler({
		input: { projectId: "p1" },
		context: { user: { id: "u1" }, session: {} },
	});
}

function status(name: string) {
	mocks.describe.mockResolvedValue({ status: { name } });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getHandle.mockReturnValue({
		describe: mocks.describe,
		query: mocks.query,
		result: mocks.result,
	});
});

describe("backlog.recommendationStatus", () => {
	it("is idle when no run exists for the project", async () => {
		const error = new Error("not found");
		error.name = "WorkflowNotFoundError";
		mocks.describe.mockRejectedValue(error);
		await expect(call()).resolves.toEqual({ state: "idle" });
		expect(mocks.getHandle).toHaveBeenCalledWith(
			"roadmap-recommendation-p1",
		);
	});

	it("reports the phase of a running run", async () => {
		status("RUNNING");
		mocks.query.mockResolvedValue({
			status: "generating",
			entryPoint: "EMPTY_ROADMAP",
		});
		await expect(call()).resolves.toEqual({
			state: "running",
			phase: "generating",
			entryPoint: "EMPTY_ROADMAP",
		});
		expect(mocks.query).toHaveBeenCalledWith(
			"roadmapRecommendationProgress",
		);
	});

	it("reports a run too new to answer its query as gathering, with the entry point from its memo", async () => {
		mocks.describe.mockResolvedValue({
			status: { name: "RUNNING" },
			memo: { entryPoint: "DO_BOTH_AFTER_PULL" },
		});
		mocks.query.mockRejectedValue(
			new Error("Workflow has not completed its first task"),
		);
		await expect(call()).resolves.toEqual({
			state: "running",
			phase: "gathering",
			entryPoint: "DO_BOTH_AFTER_PULL",
		});
	});

	it("falls back to the generic entry point when a running run has no memo", async () => {
		status("RUNNING");
		mocks.query.mockRejectedValue(new Error("no worker polling"));
		await expect(call()).resolves.toEqual({
			state: "running",
			phase: "gathering",
			entryPoint: "MATURE_ROADMAP",
		});
	});

	it("returns the outcome of a completed run", async () => {
		status("COMPLETED");
		mocks.result.mockResolvedValue({
			outcome: "GENERATED",
			entryPoint: "MATURE_ROADMAP",
			proposalId: "batch-1",
			changeCount: 27,
		});
		await expect(call()).resolves.toEqual({
			state: "completed",
			outcome: "GENERATED",
			proposalId: "batch-1",
			changeCount: 27,
			entryPoint: "MATURE_ROADMAP",
		});
	});

	it("returns INSUFFICIENT_CONTEXT with no batch", async () => {
		status("COMPLETED");
		mocks.result.mockResolvedValue({
			outcome: "INSUFFICIENT_CONTEXT",
			entryPoint: "EMPTY_ROADMAP",
			proposalId: null,
			changeCount: 0,
		});
		await expect(call()).resolves.toMatchObject({
			state: "completed",
			outcome: "INSUFFICIENT_CONTEXT",
			proposalId: null,
		});
	});

	it.each(["FAILED", "TERMINATED", "TIMED_OUT", "CANCELLED"])(
		"reports %s as failed with no error text",
		async (name) => {
			status(name);
			await expect(call()).resolves.toEqual({ state: "failed" });
			expect(mocks.result).not.toHaveBeenCalled();
		},
	);
});

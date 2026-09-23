/**
 * `backlog.generateRecommendations` (Fizzy #2208). Door order: project →
 * ROADMAP_RECOMMENDATIONS flag for the project's organization → a run already
 * in flight → the `roadmap.recommend-features` capability gate → the start.
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
	projectFindUnique: vi.fn(),
	isFeatureEnabled: vi.fn(),
	describe: vi.fn(),
	getHandle: vi.fn(),
	workflowStart: vi.fn(),
	assertCapabilityAvailable: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: mocks.projectFindUnique } },
	isFeatureEnabled: mocks.isFeatureEnabled,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart, getHandle: mocks.getHandle },
	})),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));
vi.mock("../../../../capabilities/assert", () => ({
	assertCapabilityAvailable: mocks.assertCapabilityAvailable,
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
		Permissions: { PROJECT_UPDATE: "PROJECT_UPDATE" },
		requireProjectPermission: vi.fn(() => vi.fn()),
		tenantProtectedProcedure: builder,
	};
});

await import("../generate-recommendations");

function named(name: string): Error {
	const error = new Error(name);
	error.name = name;
	return error;
}

function call(entryPoint = "MATURE_ROADMAP") {
	if (!captured.handler) {
		throw new Error("handler was not captured");
	}
	return captured.handler({
		input: { projectId: "p1", entryPoint },
		context: { user: { id: "u1" }, session: {} },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.getHandle.mockReturnValue({ describe: mocks.describe });
	mocks.describe.mockRejectedValue(named("WorkflowNotFoundError"));
	mocks.assertCapabilityAvailable.mockResolvedValue(null);
	mocks.workflowStart.mockResolvedValue({});
});

describe("backlog.generateRecommendations", () => {
	it("throws NOT_FOUND when the project does not exist", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);
		await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND with the flag off for the project's org, without the gate or a start", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"ROADMAP_RECOMMENDATIONS",
			"org-1",
		);
		expect(mocks.assertCapabilityAvailable).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("returns alreadyRunning for a run in flight, without the gate", async () => {
		mocks.describe.mockResolvedValue({ status: { name: "RUNNING" } });
		const result = await call();
		expect(result).toEqual({
			workflowId: "roadmap-recommendation-p1",
			alreadyRunning: true,
		});
		expect(mocks.getHandle).toHaveBeenCalledWith(
			"roadmap-recommendation-p1",
		);
		expect(mocks.assertCapabilityAvailable).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("starts nothing when the capability gate refuses", async () => {
		mocks.assertCapabilityAvailable.mockRejectedValue(
			new Error("SOFT_BLOCK"),
		);
		await expect(call()).rejects.toThrow("SOFT_BLOCK");
		expect(mocks.assertCapabilityAvailable).toHaveBeenCalledWith({
			capabilityKey: "roadmap.recommend-features",
			projectId: "p1",
			userId: "u1",
			organizationId: "org-1",
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("starts the workflow on ai-chat with the project's organization", async () => {
		mocks.describe.mockResolvedValue({ status: { name: "COMPLETED" } });
		const result = await call("DO_BOTH_AFTER_PULL");
		expect(result).toEqual({
			workflowId: "roadmap-recommendation-p1",
			alreadyRunning: false,
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"roadmapRecommendationWorkflow",
			expect.objectContaining({
				taskQueue: "ai-chat",
				workflowId: "roadmap-recommendation-p1",
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				memo: { entryPoint: "DO_BOTH_AFTER_PULL" },
				args: [
					{
						projectId: "p1",
						userId: "u1",
						organizationId: "org-1",
						entryPoint: "DO_BOTH_AFTER_PULL",
						requestedAt: expect.any(String),
					},
				],
			}),
		);
	});

	it("treats a lost start race as alreadyRunning", async () => {
		mocks.workflowStart.mockRejectedValue(
			named("WorkflowExecutionAlreadyStartedError"),
		);
		const result = await call();
		expect(result).toEqual({
			workflowId: "roadmap-recommendation-p1",
			alreadyRunning: true,
		});
	});
});

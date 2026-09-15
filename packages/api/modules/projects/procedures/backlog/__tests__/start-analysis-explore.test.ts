/**
 * Explore intake (plan Slice 6): `startAnalysisProcedure` forwards
 * `intakeMode` to `backlogContextAnalysisWorkflow` and leaves it undefined
 * for legacy callers so the standard prompt keeps running unchanged.
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
	workflowStart: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: mocks.projectFindUnique } },
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart },
	})),
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
		resolveOrganizationId: vi.fn(() => "org-1"),
		tenantProtectedProcedure: builder,
	};
});

import { startAnalysisInputSchema } from "../start-analysis";

function getHandler(): Handler {
	if (!captured.handler) {
		throw new Error("startAnalysisProcedure handler was not captured");
	}
	return captured.handler;
}

const baseInput = {
	projectId: "p1",
	organizationId: "org-1",
	contextSources: { fetchTeamsMessages: false },
	userPrompt: "We think small lenders want a faster origination intake.",
};

describe("startAnalysisProcedure intakeMode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-1",
		});
		mocks.workflowStart.mockResolvedValue({
			workflowId: "wf-1",
			firstExecutionRunId: "run-1",
		});
	});

	it('forwards intakeMode: "explore" to the workflow input', async () => {
		await getHandler()({
			input: { ...baseInput, intakeMode: "explore" },
			context: { user: { id: "u1" }, session: {} },
		});

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		const [workflowType, options] = mocks.workflowStart.mock.calls[0] as [
			string,
			{ args: [Record<string, unknown>] },
		];
		expect(workflowType).toBe("backlogContextAnalysisWorkflow");
		expect(options.args[0]).toMatchObject({
			projectId: "p1",
			userId: "u1",
			organizationId: "org-1",
			userPrompt: baseInput.userPrompt,
			intakeMode: "explore",
		});
	});

	it("leaves intakeMode undefined for legacy callers", async () => {
		await getHandler()({
			input: baseInput,
			context: { user: { id: "u1" }, session: {} },
		});

		const [, options] = mocks.workflowStart.mock.calls[0] as [
			string,
			{ args: [Record<string, unknown>] },
		];
		expect(options.args[0]).toHaveProperty("intakeMode", undefined);
	});
});

describe("startAnalysisInputSchema intakeMode", () => {
	it("accepts explore and standard, rejects anything else, defaults to absent", () => {
		expect(
			startAnalysisInputSchema.parse({
				...baseInput,
				intakeMode: "explore",
			}).intakeMode,
		).toBe("explore");
		expect(
			startAnalysisInputSchema.parse({
				...baseInput,
				intakeMode: "standard",
			}).intakeMode,
		).toBe("standard");
		expect(
			startAnalysisInputSchema.parse(baseInput).intakeMode,
		).toBeUndefined();
		expect(() =>
			startAnalysisInputSchema.parse({
				...baseInput,
				intakeMode: "wizard",
			}),
		).toThrow();
	});
});

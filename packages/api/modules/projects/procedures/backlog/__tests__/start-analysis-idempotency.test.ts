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
	getHandle: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: mocks.projectFindUnique } },
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart, getHandle: mocks.getHandle },
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
	projectId: "example-project",
	contextSources: { fetchTeamsMessages: false, fetchSlackMessages: false },
	userPrompt: "Review context",
	organizationId: "example-untrusted-org",
	operationKey: "example-flow",
};
const stored = new Map<
	string,
	{ workflowId: string; runId: string; memo: Record<string, unknown> }
>();
const namedError = (name: string) => Object.assign(new Error(name), { name });
const call = (input: Record<string, unknown> = baseInput) =>
	getHandler()({ input, context: { user: { id: "example-user" } } });
beforeEach(() => {
	vi.clearAllMocks();
	stored.clear();
	mocks.projectFindUnique.mockImplementation(async ({ where }) => ({
		id: where.id,
		organizationId: `org-for-${where.id}`,
	}));
	mocks.getHandle.mockImplementation((id: string) => ({
		describe: async () => {
			if (!stored.has(id)) {
				throw namedError("WorkflowNotFoundError");
			}
			return stored.get(id);
		},
	}));
	mocks.workflowStart.mockImplementation(async (_type, options) => {
		if (stored.has(options.workflowId)) {
			throw namedError("WorkflowExecutionAlreadyStartedError");
		}
		const row = {
			workflowId: options.workflowId,
			runId: `run-${stored.size}`,
			memo: options.memo,
		};
		stored.set(options.workflowId, row);
		return { workflowId: row.workflowId, firstExecutionRunId: row.runId };
	});
});
describe("startAnalysis operation identity", () => {
	it("returns the existing workflow for duplicate delivery", async () => {
		const first = await call();
		const second = await call();
		expect(second).toMatchObject({
			workflowId: (first as any).workflowId,
			runId: (first as any).runId,
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ userPrompt: "Different intent" },
		{
			contextSources: {
				fetchTeamsMessages: true,
				fetchSlackMessages: false,
			},
		},
		{
			pmConfig: {
				mcpConfigId: "example-config",
				containerId: "example-container",
			},
		},
		{ conversationId: "example-other-conversation" },
		{ intakeMode: "explore" },
	])("rejects conflicting reuse: %j", async (changed) => {
		await call();
		await expect(call({ ...baseInput, ...changed })).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});
	it("recovers a successful start whose response was lost", async () => {
		const start = mocks.workflowStart.getMockImplementation();
		mocks.workflowStart.mockImplementationOnce(async (...args) => {
			await start?.(...args);
			throw new Error("Response lost");
		});
		const result = await call();
		expect((result as any).workflowId).toBe([...stored.keys()][0]);
		expect(await call()).toMatchObject({
			workflowId: (result as any).workflowId,
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});
	it("ignores an untrusted organization override on duplicate delivery", async () => {
		const first = await call();
		expect(
			await call({ ...baseInput, organizationId: "example-other-org" }),
		).toMatchObject({ workflowId: (first as any).workflowId });
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("scopes the same key to the resolved project and its tenant", async () => {
		const first = await call();
		const other = await call({
			...baseInput,
			projectId: "example-other-project",
		});
		expect((other as any).workflowId).not.toBe((first as any).workflowId);
		expect(await call()).toMatchObject({
			workflowId: (first as any).workflowId,
		});
		expect(
			await call({ ...baseInput, projectId: "example-other-project" }),
		).toMatchObject({ workflowId: (other as any).workflowId });
		expect(mocks.workflowStart).toHaveBeenCalledTimes(2);

		expect(
			mocks.workflowStart.mock.calls.map(
				(c) => c[1].args[0].organizationId,
			),
		).toEqual(["org-for-example-project", "org-for-example-other-project"]);
	});
	it("collapses concurrent starts and requests rejection of closed-id reuse", async () => {
		const results = await Promise.all([call(), call()]);
		expect((results[0] as any).workflowId).toBe(
			(results[1] as any).workflowId,
		);
		expect(stored.size).toBe(1);
		expect(mocks.workflowStart.mock.calls[0][1].workflowIdReusePolicy).toBe(
			"REJECT_DUPLICATE",
		);
	});
	it("rejects concurrent conflicting inputs for one operation key", async () => {
		const results = await Promise.allSettled([
			call(),
			call({ ...baseInput, userPrompt: "Different intent" }),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((r) => r.status === "rejected");
		expect(rejected).toMatchObject({ reason: { code: "CONFLICT" } });
		expect(stored.size).toBe(1);
	});

	it("returns a completed operation instead of restarting it", async () => {
		const first = await call();
		for (const row of stored.values()) {
			Object.assign(row, { status: { name: "COMPLETED" } });
		}
		expect(await call()).toMatchObject({
			workflowId: (first as any).workflowId,
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});
	it("normalizes object property order for duplicate delivery", async () => {
		const first = await call();
		expect(
			await call({
				...baseInput,
				contextSources: {
					fetchSlackMessages: false,
					fetchTeamsMessages: false,
				},
			}),
		).toMatchObject({ workflowId: (first as any).workflowId });
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});
	it("leaves keyless workflow starts timestamped", async () => {
		vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(101);
		const { operationKey: _, ...input } = baseInput;
		const first = await getHandler()({
			input,
			context: { user: { id: "example-user" } },
		});
		const second = await getHandler()({
			input,
			context: { user: { id: "example-user" } },
		});
		expect((first as any).workflowId).not.toBe((second as any).workflowId);
		expect(mocks.getHandle).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});
	it("accepts a bounded optional key and rejects empty keys", () => {
		expect(startAnalysisInputSchema.parse(baseInput).operationKey).toBe(
			"example-flow",
		);
		expect(() =>
			startAnalysisInputSchema.parse({ ...baseInput, operationKey: "" }),
		).toThrow();
	});
	it("does not access Temporal when the resolved project is missing", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);
		await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.getHandle).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

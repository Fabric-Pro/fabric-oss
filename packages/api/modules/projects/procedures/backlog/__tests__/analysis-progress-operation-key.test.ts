import { beforeEach, describe, expect, it, vi } from "vitest";
import { backlogAnalysisWorkflowId } from "../workflow-id";

const h = vi.hoisted(() => ({
	handler: null as any,
	client: vi.fn(),
	query: vi.fn(),
	handle: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder = {
		use: () => builder,
		route: () => builder,
		input: () => builder,
		handler: (fn: unknown) => {
			h.handler = fn;
			return builder;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: vi.fn(),
		Permissions: { PROJECT_UPDATE: "PROJECT_UPDATE" },
	};
});
vi.mock("@repo/temporal", async () => ({
	...(await import(
		"../../../../../../temporal/src/workflows/backlog-constants"
	)),
	getTemporalClient: h.client,
	analysisProgressQuery: "progress",
	analysisResultQuery: "proposal",
}));
import "../analysis-progress";

beforeEach(() => {
	vi.clearAllMocks();
	h.client.mockResolvedValue({ workflow: { getHandle: h.handle } });
	h.handle.mockReturnValue({ query: h.query });
	h.query.mockImplementation(async (query) =>
		query === "progress"
			? { status: "complete" }
			: { changes: [], summary: "Ready" },
	);
});
describe("analysis progress operation-key ownership", () => {
	it("accepts deterministic operation ids and returns that workflow's proposal", async () => {
		const workflowId = backlogAnalysisWorkflowId(
			"example-project",
			"example-flow",
		);
		expect(
			await h.handler({
				input: { projectId: "example-project", workflowId },
			}),
		).toEqual({
			progress: { status: "complete" },
			proposal: { changes: [], summary: "Ready" },
		});
		expect(h.handle).toHaveBeenCalledExactlyOnceWith(workflowId);
	});
	it("rejects a foreign project's operation before any Temporal access", async () => {
		const workflowId = backlogAnalysisWorkflowId(
			"example-other-project",
			"example-flow",
		);
		await expect(
			h.handler({ input: { projectId: "example-project", workflowId } }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(h.client).not.toHaveBeenCalled();
		expect(h.handle).not.toHaveBeenCalled();
	});
});

it("carries the PM note from progress and from a completed result fallback", async () => {
	const note = "Couldn't read your PM board.";
	const input = {
		projectId: "example-project",
		workflowId: backlogAnalysisWorkflowId(
			"example-project",
			"example-flow",
		),
	};
	h.query.mockResolvedValue({ status: "complete", pmContextNote: note });
	expect((await h.handler({ input })).progress.pmContextNote).toBe(note);
	h.query.mockRejectedValue(new Error("Query unavailable"));
	h.handle.mockReturnValue({
		query: h.query,
		result: vi.fn(async () => ({ success: true, pmContextNote: note })),
	});
	expect((await h.handler({ input })).progress.pmContextNote).toBe(note);
});

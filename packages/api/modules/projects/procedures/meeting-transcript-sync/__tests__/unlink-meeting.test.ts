/**
 * Unit tests for `unlinkMeetingProcedure` — context cleanup fallback (#1905, D4).
 *
 * Contexts carrying a Qdrant vector are handed to `contextDeletionWorkflow`,
 * which owns BOTH the vector deletion and the DB row deletion so the two cannot
 * race. If a workflow start fails, that context falls back to a direct DB
 * delete, which orphans its vector — so the fallback must be per-context (never
 * re-queuing contexts whose workflows already started) and must be logged.
 *
 * Handler-capture + mocked-builder pattern mirrors the sibling
 * `set-auto-analyze.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		projectFindFirst: vi.fn(),
		transcriptFindMany: vi.fn(),
		contextFindMany: vi.fn(),
		contextDeleteMany: vi.fn(),
		unlinkMeetingFromProject: vi.fn(),
		workflowStart: vi.fn(),
		getTemporalClient: vi.fn(),
		requireProjectPermission: vi.fn(() => (c: unknown) => c),
		loggerError: vi.fn(),
	};
	return { handlers, mocks };
});

// Partial mock: keep every real export (so transitive top-level side effects
// still resolve) and override only `db` plus the unlink query helper.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			project: {
				findFirst: (...a: unknown[]) => mocks.projectFindFirst(...a),
			},
			projectMeetingTranscript: {
				findMany: (...a: unknown[]) => mocks.transcriptFindMany(...a),
			},
			projectContext: {
				findMany: (...a: unknown[]) => mocks.contextFindMany(...a),
				deleteMany: (...a: unknown[]) => mocks.contextDeleteMany(...a),
			},
		},
		unlinkMeetingFromProject: (...a: unknown[]) =>
			mocks.unlinkMeetingFromProject(...a),
	};
});

vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...a: unknown[]) => mocks.getTemporalClient(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		error: (...a: unknown[]) => mocks.loggerError(...a),
		warn: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["unlinkMeeting"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: (...a: unknown[]) =>
			mocks.requireProjectPermission(...a),
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../unlink-meeting");

const ctx = {
	user: { id: "user-1", name: "Ada", email: "ada@example.com" },
	session: {},
};

const input = {
	projectId: "project-1",
	organizationId: "org-1",
	linkedMeetingId: "linked-1",
};

beforeEach(() => {
	mocks.projectFindFirst.mockReset();
	mocks.transcriptFindMany.mockReset();
	mocks.contextFindMany.mockReset();
	mocks.contextDeleteMany.mockReset();
	mocks.unlinkMeetingFromProject.mockReset();
	mocks.workflowStart.mockReset();
	mocks.getTemporalClient.mockReset();
	mocks.loggerError.mockReset();

	mocks.projectFindFirst.mockResolvedValue({ id: "project-1" });
	mocks.unlinkMeetingFromProject.mockResolvedValue({ id: "linked-1" });
	mocks.contextDeleteMany.mockResolvedValue({ count: 0 });
	mocks.workflowStart.mockResolvedValue({ workflowId: "wf-1" });
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: (...a: unknown[]) => mocks.workflowStart(...a) },
	});
});

describe("unlinkMeetingProcedure — context cleanup", () => {
	it("hands every vector-backed context to the workflow and direct-deletes only the rest", async () => {
		mocks.transcriptFindMany.mockResolvedValue([
			{ contextId: "ctx-vector" },
			{ contextId: "ctx-plain" },
		]);
		mocks.contextFindMany.mockResolvedValue([
			{ id: "ctx-vector", qdrantId: "qd-1", type: "MEETING_TRANSCRIPT" },
			{ id: "ctx-plain", qdrantId: null, type: "MEETING_TRANSCRIPT" },
		]);

		await handlers.unlinkMeeting({ input, context: ctx });

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(mocks.contextDeleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["ctx-plain"] }, projectId: "project-1" },
		});
		expect(mocks.loggerError).not.toHaveBeenCalled();
	});

	it("falls back for only the failing context, and logs the orphaned vector", async () => {
		mocks.transcriptFindMany.mockResolvedValue([
			{ contextId: "ctx-a" },
			{ contextId: "ctx-b" },
		]);
		mocks.contextFindMany.mockResolvedValue([
			{ id: "ctx-a", qdrantId: "qd-a", type: "MEETING_TRANSCRIPT" },
			{ id: "ctx-b", qdrantId: "qd-b", type: "MEETING_TRANSCRIPT" },
		]);
		// ctx-a's workflow starts; ctx-b's fails.
		mocks.workflowStart
			.mockResolvedValueOnce({ workflowId: "wf-a" })
			.mockRejectedValueOnce(new Error("temporal unavailable"));

		const result = (await handlers.unlinkMeeting({
			input,
			context: ctx,
		})) as { success: boolean };

		expect(result.success).toBe(true);
		// ctx-a already has a workflow that will delete its row — it must NOT
		// be re-queued for direct deletion.
		expect(mocks.contextDeleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["ctx-b"] }, projectId: "project-1" },
		});
		expect(mocks.loggerError).toHaveBeenCalledWith(
			"meeting.unlink.context_deletion_workflow_failed",
			expect.objectContaining({
				contextId: "ctx-b",
				qdrantId: "qd-b",
				projectId: "project-1",
			}),
		);
	});

	it("direct-deletes everything and logs once when the temporal client is unavailable", async () => {
		mocks.transcriptFindMany.mockResolvedValue([{ contextId: "ctx-a" }]);
		mocks.contextFindMany.mockResolvedValue([
			{ id: "ctx-a", qdrantId: "qd-a", type: "MEETING_TRANSCRIPT" },
		]);
		mocks.getTemporalClient.mockRejectedValue(new Error("no client"));

		await handlers.unlinkMeeting({ input, context: ctx });

		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.contextDeleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["ctx-a"] }, projectId: "project-1" },
		});
		expect(mocks.loggerError).toHaveBeenCalledWith(
			"meeting.unlink.temporal_client_unavailable",
			expect.objectContaining({ projectId: "project-1" }),
		);
	});

	it("unlinks and skips context cleanup entirely when no transcript had a context", async () => {
		mocks.transcriptFindMany.mockResolvedValue([]);

		await handlers.unlinkMeeting({ input, context: ctx });

		expect(mocks.unlinkMeetingFromProject).toHaveBeenCalledWith(
			"project-1",
			"linked-1",
		);
		expect(mocks.contextFindMany).not.toHaveBeenCalled();
		expect(mocks.contextDeleteMany).not.toHaveBeenCalled();
	});
});

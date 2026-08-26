/**
 * Unit tests for `cancelDraftCrawlsProcedure` — Unified Context Uploader
 * Wizard spec §5.1, §13.1.
 *
 * Six scenarios covered (tasks.md Group 2.6):
 *   (a) DRAFT-only guard rejects ACTIVE projects with `BAD_REQUEST`.
 *   (b) Batch iteration cancels every PENDING/EXTRACTING LINK row via the
 *       mocked Temporal client.
 *   (c) Terminal-status rows are filtered out of the candidate query but
 *       counted under `skippedTerminalCount`.
 *   (d) `WorkflowNotFoundError` per row is treated as silent success — no
 *       entry pushed to `errors[]`.
 *   (e) Genuine Temporal failure is appended to `errors[]` without
 *       aborting the rest of the batch.
 *   (f) XOR tenancy enforced — personal vs org context both flow through
 *       the same handler with the right shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockProjectFindFirst,
	mockProjectContextFindMany,
	mockProjectContextCount,
	mockTemporalCancel,
	mockTemporalGetHandle,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockProjectFindFirst: vi.fn(),
	mockProjectContextFindMany: vi.fn(),
	mockProjectContextCount: vi.fn(),
	mockTemporalCancel: vi.fn(),
	mockTemporalGetHandle: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mockProjectFindFirst },
		projectContext: {
			findMany: mockProjectContextFindMany,
			count: mockProjectContextCount,
		},
	},
	hasProjectAccess: mockHasProjectAccess,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { getHandle: mockTemporalGetHandle },
	})),
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
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			if (input) {
				return input;
			}
			if (input === null) {
				return undefined;
			}
			return session?.activeOrganizationId ?? undefined;
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: {
		projectId: string;
		organizationId?: string | null;
	};
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<{
	cancelledCount: number;
	skippedTerminalCount: number;
	errors: Array<{ contextId: string; message: string }>;
}>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../cancel-draft-crawls");
	return (mod.cancelDraftCrawlsProcedure as unknown as { handler: Handler })
		.handler;
}

const personalCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: undefined },
};

const orgCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockProjectContextCount.mockResolvedValue(0);
	mockTemporalCancel.mockResolvedValue(undefined);
	mockTemporalGetHandle.mockReturnValue({ cancel: mockTemporalCancel });
});

// ─────────────────────────────────────────────────────────────────────
// (a) DRAFT-only guard
// ─────────────────────────────────────────────────────────────────────

describe("cancelDraftCrawls — DRAFT-only guard", () => {
	it.each(["ACTIVE", "ARCHIVED"] as const)(
		"throws BAD_REQUEST (NOT_A_DRAFT_PROJECT) when project status is %s",
		async (status) => {
			mockProjectFindFirst.mockResolvedValue({
				id: "proj-1",
				status,
			});
			const handler = await loadHandler();

			await expect(
				handler({
					input: { projectId: "proj-1" },
					context: personalCtx,
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				data: { code: "NOT_A_DRAFT_PROJECT" },
			});

			// No Temporal calls if the guard rejects.
			expect(mockTemporalGetHandle).not.toHaveBeenCalled();
			expect(mockTemporalCancel).not.toHaveBeenCalled();
		},
	);

	it("throws FORBIDDEN when hasProjectAccess returns false", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const handler = await loadHandler();

		await expect(
			handler({
				input: { projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockProjectFindFirst).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when project lookup returns null (race with soft-delete)", async () => {
		mockProjectFindFirst.mockResolvedValue(null);
		const handler = await loadHandler();

		await expect(
			handler({
				input: { projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

// ─────────────────────────────────────────────────────────────────────
// (b) Batch iteration — happy path
// ─────────────────────────────────────────────────────────────────────

describe("cancelDraftCrawls — batch iteration", () => {
	it("cancels every PENDING/EXTRACTING LINK row via Temporal", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			status: "DRAFT",
		});
		mockProjectContextFindMany.mockResolvedValue([
			{ id: "ctx-1", urlActiveWorkflowId: "wf-1" },
			{ id: "ctx-2", urlActiveWorkflowId: "wf-2" },
			{ id: "ctx-3", urlActiveWorkflowId: "wf-3" },
		]);
		const handler = await loadHandler();

		const result = await handler({
			input: { projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockTemporalGetHandle).toHaveBeenCalledTimes(3);
		expect(mockTemporalGetHandle).toHaveBeenNthCalledWith(1, "wf-1");
		expect(mockTemporalGetHandle).toHaveBeenNthCalledWith(2, "wf-2");
		expect(mockTemporalGetHandle).toHaveBeenNthCalledWith(3, "wf-3");
		expect(mockTemporalCancel).toHaveBeenCalledTimes(3);
		expect(result).toEqual({
			cancelledCount: 3,
			skippedTerminalCount: 0,
			errors: [],
		});
	});

	it("returns zero counts when no live LINK rows exist (no Temporal client touched for the loop)", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			status: "DRAFT",
		});
		mockProjectContextFindMany.mockResolvedValue([]);
		const handler = await loadHandler();

		const result = await handler({
			input: { projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockTemporalGetHandle).not.toHaveBeenCalled();
		expect(result).toEqual({
			cancelledCount: 0,
			skippedTerminalCount: 0,
			errors: [],
		});
	});
});

// ─────────────────────────────────────────────────────────────────────
// (c) Terminal rows are filtered out of cancel candidates and surfaced
//     under `skippedTerminalCount`.
// ─────────────────────────────────────────────────────────────────────

describe("cancelDraftCrawls — terminal-status rows", () => {
	it("scopes the cancel candidate query to PENDING/EXTRACTING + non-null workflowId, surfaces terminal count separately", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			status: "DRAFT",
		});
		mockProjectContextFindMany.mockResolvedValue([
			{ id: "ctx-1", urlActiveWorkflowId: "wf-1" },
		]);
		mockProjectContextCount.mockResolvedValue(4);
		const handler = await loadHandler();

		const result = await handler({
			input: { projectId: "proj-1" },
			context: personalCtx,
		});

		// Cancel candidate query: PENDING/EXTRACTING + non-null workflowId.
		expect(mockProjectContextFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "proj-1",
				type: "LINK",
				extractionStatus: { in: ["PENDING", "EXTRACTING"] },
				urlActiveWorkflowId: { not: null },
			},
			select: { id: true, urlActiveWorkflowId: true },
		});
		// Separate count for already-terminal rows so the response can
		// reason about "we saw N terminal rows, didn't touch them".
		expect(mockProjectContextCount).toHaveBeenCalledWith({
			where: {
				projectId: "proj-1",
				type: "LINK",
				extractionStatus: { in: ["COMPLETED", "FAILED", "CANCELLED"] },
			},
		});
		expect(result).toEqual({
			cancelledCount: 1,
			skippedTerminalCount: 4,
			errors: [],
		});
	});
});

// ─────────────────────────────────────────────────────────────────────
// (d) WorkflowNotFoundError race-with-completion → silent success.
// ─────────────────────────────────────────────────────────────────────

describe("cancelDraftCrawls — race with workflow completion", () => {
	it("treats Temporal 'workflow not found' per row as silent success (no error pushed)", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			status: "DRAFT",
		});
		mockProjectContextFindMany.mockResolvedValue([
			{ id: "ctx-1", urlActiveWorkflowId: "wf-1" },
			{ id: "ctx-2", urlActiveWorkflowId: "wf-2" },
		]);
		// Both workflows raced to completion before our cancel landed.
		// Temporal's actual error text is "workflow not found" (the per-row
		// procedure at cancel-url-source-crawl.ts:128 matches /not\s+found/i).
		mockTemporalCancel
			.mockRejectedValueOnce(new Error("workflow not found"))
			.mockRejectedValueOnce(
				new Error(
					"sdk.WorkflowNotFoundError: workflow execution not found",
				),
			);
		const handler = await loadHandler();

		const result = await handler({
			input: { projectId: "proj-1" },
			context: personalCtx,
		});

		expect(result).toEqual({
			cancelledCount: 2,
			skippedTerminalCount: 0,
			errors: [],
		});
	});
});

// ─────────────────────────────────────────────────────────────────────
// (e) Genuine Temporal failure — appended to errors[], batch continues.
// ─────────────────────────────────────────────────────────────────────

describe("cancelDraftCrawls — genuine failure handling", () => {
	it("appends genuine Temporal failures to errors[] without aborting the batch", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			status: "DRAFT",
		});
		mockProjectContextFindMany.mockResolvedValue([
			{ id: "ctx-1", urlActiveWorkflowId: "wf-1" },
			{ id: "ctx-2", urlActiveWorkflowId: "wf-2" },
			{ id: "ctx-3", urlActiveWorkflowId: "wf-3" },
		]);
		mockTemporalCancel
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("Internal Temporal failure"))
			.mockResolvedValueOnce(undefined);
		const handler = await loadHandler();

		const result = await handler({
			input: { projectId: "proj-1" },
			context: personalCtx,
		});

		// All three rows attempted; only the failing one shows up in errors.
		expect(mockTemporalCancel).toHaveBeenCalledTimes(3);
		expect(result).toEqual({
			cancelledCount: 2,
			skippedTerminalCount: 0,
			errors: [
				{ contextId: "ctx-2", message: "Internal Temporal failure" },
			],
		});
	});
});

// ─────────────────────────────────────────────────────────────────────
// (f) XOR tenancy — personal vs org.
// ─────────────────────────────────────────────────────────────────────

describe("cancelDraftCrawls — XOR tenancy", () => {
	it("personal context applies organizationId: null on the project lookup", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			status: "DRAFT",
		});
		mockProjectContextFindMany.mockResolvedValue([]);
		const handler = await loadHandler();

		await handler({
			input: { projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockHasProjectAccess).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
			undefined,
		);
		expect(mockProjectFindFirst).toHaveBeenCalledWith({
			where: {
				id: "proj-1",
				organizationId: null,
				userId: "user-1",
			},
			select: { id: true, status: true },
		});
	});

	it("org context applies organizationId: <id> on the project lookup", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			status: "DRAFT",
		});
		mockProjectContextFindMany.mockResolvedValue([]);
		const handler = await loadHandler();

		await handler({
			input: { projectId: "proj-1" },
			context: orgCtx,
		});

		expect(mockHasProjectAccess).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
			"org-1",
		);
		expect(mockProjectFindFirst).toHaveBeenCalledWith({
			where: {
				id: "proj-1",
				organizationId: "org-1",
				userId: "user-1",
			},
			select: { id: true, status: true },
		});
	});

	it("explicit input.organizationId overrides the session active org", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			status: "DRAFT",
		});
		mockProjectContextFindMany.mockResolvedValue([]);
		const handler = await loadHandler();

		await handler({
			input: { projectId: "proj-1", organizationId: "org-other" },
			context: orgCtx,
		});

		expect(mockHasProjectAccess).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
			"org-other",
		);
		expect(mockProjectFindFirst).toHaveBeenCalledWith({
			where: {
				id: "proj-1",
				organizationId: "org-other",
				userId: "user-1",
			},
			select: { id: true, status: true },
		});
	});
});

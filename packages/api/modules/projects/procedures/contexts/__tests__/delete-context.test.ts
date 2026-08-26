/**
 * Unit tests for `deleteContextProcedure` — URL Context Sources spec §6.6
 * + §7.2 schedule cleanup.
 *
 * Focus: when deleting a LINK row with `urlScheduleId` set, the procedure
 * MUST drop the Temporal Schedule BEFORE starting the context-deletion
 * workflow, but a schedule-delete failure MUST NOT block the rest of the
 * delete path (the reconciliation workflow sweeps drift).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetContextById,
	mockHasProjectAccess,
	mockGetTemporalClient,
	mockTemporalStart,
	mockGetScheduleClient,
	mockDeleteUrlSourceSchedule,
	mockEmitContextChange,
	mockEmitActivity,
} = vi.hoisted(() => ({
	mockGetContextById: vi.fn(),
	mockHasProjectAccess: vi.fn(),
	mockGetTemporalClient: vi.fn(),
	mockTemporalStart: vi.fn(),
	mockGetScheduleClient: vi.fn(),
	mockDeleteUrlSourceSchedule: vi.fn(),
	mockEmitContextChange: vi.fn(),
	mockEmitActivity: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getContextById: mockGetContextById,
	hasProjectAccess: mockHasProjectAccess,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
	getScheduleClient: mockGetScheduleClient,
	deleteUrlSourceSchedule: mockDeleteUrlSourceSchedule,
}));

vi.mock("../../../../lib/realtime", () => ({
	emitContextChange: mockEmitContextChange,
	emitActivity: mockEmitActivity,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
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
	input: { id: string; projectId: string; organizationId?: string | null };
	context: {
		user: { id: string; name?: string; email?: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../delete-context");
	return (mod.deleteContextProcedure as unknown as { handler: Handler })
		.handler;
}

const personalCtx = {
	user: { id: "user-1", name: "Test User", email: "test@example.com" },
	session: { activeOrganizationId: undefined },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: mockTemporalStart },
	});
	mockGetScheduleClient.mockResolvedValue({});
	mockTemporalStart.mockResolvedValue(undefined);
	mockDeleteUrlSourceSchedule.mockResolvedValue({ deleted: true });
	mockEmitContextChange.mockResolvedValue(undefined);
	mockEmitActivity.mockResolvedValue(undefined);
});

describe("deleteContext — URL Source schedule cleanup", () => {
	it("drops the schedule BEFORE starting the deletion workflow for LINK + urlScheduleId", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-link",
			projectId: "proj-1",
			type: "LINK",
			sourceTitle: "Docs",
			urlScheduleId: "url-source-schedule-ctx-link",
		});

		// Track call order: pushing each fn name into a single log.
		const callOrder: string[] = [];
		mockDeleteUrlSourceSchedule.mockImplementation(async () => {
			callOrder.push("deleteSchedule");
			return { deleted: true };
		});
		mockTemporalStart.mockImplementation(async () => {
			callOrder.push("workflowStart");
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { id: "ctx-link", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(result).toEqual({ success: true });
		expect(mockDeleteUrlSourceSchedule).toHaveBeenCalledWith(
			{ scheduleId: "url-source-schedule-ctx-link" },
			expect.anything(),
		);
		expect(callOrder).toEqual(["deleteSchedule", "workflowStart"]);
	});

	it("does NOT call deleteUrlSourceSchedule for LINK rows without urlScheduleId", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-link",
			projectId: "proj-1",
			type: "LINK",
			sourceTitle: "Article",
			urlScheduleId: null,
		});

		const handler = await loadHandler();
		await handler({
			input: { id: "ctx-link", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockDeleteUrlSourceSchedule).not.toHaveBeenCalled();
	});

	it("does NOT call deleteUrlSourceSchedule for non-LINK contexts", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-file",
			projectId: "proj-1",
			type: "FILE",
			urlScheduleId: null,
		});

		const handler = await loadHandler();
		await handler({
			input: { id: "ctx-file", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockDeleteUrlSourceSchedule).not.toHaveBeenCalled();
	});

	it.each([["PENDING"], ["EXTRACTING"]])(
		"rejects with CONFLICT when a LINK row is mid-crawl (status=%s)",
		async (status) => {
			// Lock-while-crawling guard. Deleting mid-crawl would orphan
			// the in-flight Temporal workflow against a row about to be
			// cascade-deleted. Force the user to cancel first; the
			// dedicated `cancelUrlSourceCrawl` procedure handles
			// orderly teardown.
			mockGetContextById.mockResolvedValue({
				id: "ctx-link",
				projectId: "proj-1",
				type: "LINK",
				sourceTitle: "Docs",
				urlScheduleId: null,
				extractionStatus: status,
			});

			const handler = await loadHandler();
			await expect(
				handler({
					input: { id: "ctx-link", projectId: "proj-1" },
					context: personalCtx,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
			});

			// Critically: nothing downstream of the guard runs.
			expect(mockDeleteUrlSourceSchedule).not.toHaveBeenCalled();
			expect(mockTemporalStart).not.toHaveBeenCalled();
			expect(mockEmitContextChange).not.toHaveBeenCalled();
		},
	);

	it.each([["COMPLETED"], ["FAILED"], ["CANCELLED"]])(
		"allows delete when LINK row is in terminal status %s",
		async (status) => {
			// Terminal statuses are safe to delete from. CANCELLED is
			// explicitly terminal — the cancel-crawl flow finalizes
			// to this state precisely so the row becomes deletable
			// again.
			mockGetContextById.mockResolvedValue({
				id: "ctx-link",
				projectId: "proj-1",
				type: "LINK",
				sourceTitle: "Docs",
				urlScheduleId: null,
				extractionStatus: status,
			});

			const handler = await loadHandler();
			const result = await handler({
				input: { id: "ctx-link", projectId: "proj-1" },
				context: personalCtx,
			});
			expect(result).toEqual({ success: true });
			expect(mockTemporalStart).toHaveBeenCalled();
		},
	);

	it("does NOT apply the crawl guard to non-LINK contexts", async () => {
		// FILE / TEXT / MEETING_TRANSCRIPT don't have crawls, so a
		// stale extractionStatus value should never block their delete.
		mockGetContextById.mockResolvedValue({
			id: "ctx-file",
			projectId: "proj-1",
			type: "FILE",
			extractionStatus: "EXTRACTING",
			urlScheduleId: null,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { id: "ctx-file", projectId: "proj-1" },
			context: personalCtx,
		});
		expect(result).toEqual({ success: true });
		expect(mockTemporalStart).toHaveBeenCalled();
	});

	it("schedule-delete failure does NOT block the DB delete", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-link",
			projectId: "proj-1",
			type: "LINK",
			sourceTitle: "Docs",
			urlScheduleId: "url-source-schedule-ctx-link",
		});
		mockDeleteUrlSourceSchedule.mockRejectedValueOnce(
			new Error("temporal unavailable"),
		);

		const handler = await loadHandler();
		const result = await handler({
			input: { id: "ctx-link", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(result).toEqual({ success: true });
		// The deletion workflow still ran.
		expect(mockTemporalStart).toHaveBeenCalledWith(
			"contextDeletionWorkflow",
			expect.anything(),
		);
	});
});

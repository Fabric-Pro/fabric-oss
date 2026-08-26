/**
 * Unit tests for `cancelUrlSourceCrawlProcedure`.
 *
 * Covers:
 *  - Happy path: looks up urlActiveWorkflowId, calls Temporal cancel.
 *  - NOT_FOUND for cross-tenant addressing.
 *  - BAD_REQUEST when context is in a terminal state (COMPLETED/FAILED).
 *  - BAD_REQUEST when urlActiveWorkflowId is null on an in-flight row.
 *  - Treats Temporal "workflow not found" (race with completion) as success
 *    and clears the stale workflowId.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockGetContextById,
	mockProjectContextUpdate,
	mockTemporalCancel,
	mockTemporalGetHandle,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockGetContextById: vi.fn(),
	mockProjectContextUpdate: vi.fn(),
	mockTemporalCancel: vi.fn(),
	mockTemporalGetHandle: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { projectContext: { update: mockProjectContextUpdate } },
	getContextById: mockGetContextById,
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
		contextId: string;
		projectId: string;
		organizationId?: string | null;
	};
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../cancel-url-source-crawl");
	return (
		mod.cancelUrlSourceCrawlProcedure as unknown as { handler: Handler }
	).handler;
}

const personalCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: undefined },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockProjectContextUpdate.mockResolvedValue(undefined);
	mockTemporalCancel.mockResolvedValue(undefined);
	mockTemporalGetHandle.mockReturnValue({ cancel: mockTemporalCancel });
});

describe("cancelUrlSourceCrawl — happy path", () => {
	it("looks up urlActiveWorkflowId and sends Temporal cancel", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-1",
			type: "LINK",
			sourceUrl: "https://example.com/docs",
			extractionStatus: "EXTRACTING",
			urlActiveWorkflowId: "url-crawl-ctx-1-resync-1234567",
		});
		const handler = await loadHandler();

		const result = await handler({
			input: { contextId: "ctx-1", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockTemporalGetHandle).toHaveBeenCalledWith(
			"url-crawl-ctx-1-resync-1234567",
		);
		expect(mockTemporalCancel).toHaveBeenCalledOnce();
		expect(result).toEqual({
			contextId: "ctx-1",
			status: "CANCELLING",
		});
	});
});

describe("cancelUrlSourceCrawl — tenant isolation", () => {
	it("returns NOT_FOUND for cross-tenant contextId", async () => {
		mockGetContextById.mockResolvedValue(null);
		const handler = await loadHandler();

		await expect(
			handler({
				input: { contextId: "ctx-other", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("cancelUrlSourceCrawl — wrong-state guard", () => {
	it.each(["COMPLETED", "FAILED"] as const)(
		"returns BAD_REQUEST when extractionStatus is %s",
		async (status) => {
			mockGetContextById.mockResolvedValue({
				id: "ctx-1",
				projectId: "proj-1",
				type: "LINK",
				sourceUrl: "https://example.com/docs",
				extractionStatus: status,
				urlActiveWorkflowId: null,
			});
			const handler = await loadHandler();
			await expect(
				handler({
					input: { contextId: "ctx-1", projectId: "proj-1" },
					context: personalCtx,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mockTemporalCancel).not.toHaveBeenCalled();
		},
	);

	it("returns BAD_REQUEST when status is in-flight but urlActiveWorkflowId is null (legacy row)", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-1",
			type: "LINK",
			sourceUrl: "https://example.com/docs",
			extractionStatus: "EXTRACTING",
			urlActiveWorkflowId: null,
		});
		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-1", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("cancelUrlSourceCrawl — race with workflow completion", () => {
	it("treats Temporal 'not found' as success and clears stale workflowId", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-1",
			type: "LINK",
			sourceUrl: "https://example.com/docs",
			extractionStatus: "EXTRACTING",
			urlActiveWorkflowId: "url-crawl-ctx-1-resync-1234567",
		});
		mockTemporalCancel.mockRejectedValueOnce(
			new Error("workflow not found"),
		);
		const handler = await loadHandler();

		const result = await handler({
			input: { contextId: "ctx-1", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(result).toEqual({
			contextId: "ctx-1",
			status: "ALREADY_FINISHED",
		});
		expect(mockProjectContextUpdate).toHaveBeenCalledWith({
			where: { id: "ctx-1" },
			data: { urlActiveWorkflowId: null },
		});
	});
});

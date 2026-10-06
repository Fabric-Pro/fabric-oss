/**
 * Unit tests for `retryStalledContextProcedure` (Fizzy #2886).
 *
 * Covers:
 *   - Each dispatch branch starts the workflow that produced the row, under a
 *     fresh workflow id — a stored original is re-extracted as a retry, a link
 *     is crawled again, a row holding its own text is embedded again.
 *   - A row still moving is refused (CONFLICT), so a live run is never doubled.
 *   - A live integration, whose status never moves, is refused.
 *   - NOT_FOUND for cross-tenant addressing; the org comes from the session.
 *   - A dead run's job rows are closed, so the banner's clock restarts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockGetContextById,
	mockGetSearchProviderConfig,
	mockUpdateContextExtractionStatus,
	mockOrgFindUnique,
	mockProjectContextUpdate,
	mockProjectContextUpdateMany,
	mockBackgroundJobFindMany,
	mockCreateBackgroundJob,
	mockFailBackgroundJob,
	mockTemporalWorkflowStart,
	mockDescribe,
	mockDecryptApiKey,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockGetContextById: vi.fn(),
	mockGetSearchProviderConfig: vi.fn(),
	mockUpdateContextExtractionStatus: vi.fn(),
	mockOrgFindUnique: vi.fn(),
	mockProjectContextUpdate: vi.fn(),
	mockProjectContextUpdateMany: vi.fn(),
	mockBackgroundJobFindMany: vi.fn(),
	mockCreateBackgroundJob: vi.fn(),
	mockFailBackgroundJob: vi.fn(),
	mockTemporalWorkflowStart: vi.fn(),
	mockDescribe: vi.fn(),
	mockDecryptApiKey: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		organization: { findUnique: mockOrgFindUnique },
		projectContext: {
			update: mockProjectContextUpdate,
			updateMany: mockProjectContextUpdateMany,
		},
		backgroundJob: { findMany: mockBackgroundJobFindMany },
	},
	createBackgroundJob: mockCreateBackgroundJob,
	failBackgroundJob: mockFailBackgroundJob,
	getContextById: mockGetContextById,
	getSearchProviderConfig: mockGetSearchProviderConfig,
	hasProjectAccess: mockHasProjectAccess,
	seedSteps: (keys: string[]) => keys.map((key) => ({ key })),
	updateContextExtractionStatus: mockUpdateContextExtractionStatus,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: {
			start: mockTemporalWorkflowStart,
			getHandle: () => ({ describe: mockDescribe }),
		},
	})),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: mockDecryptApiKey,
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
		) => input ?? session?.activeOrganizationId ?? undefined,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: { contextId: string; projectId: string };
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<{ contextId: string; dispatch: string; workflowId: string }>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../retry-stalled-context");
	return (mod.retryStalledContextProcedure as unknown as { handler: Handler })
		.handler;
}

const ORG_ID = "org_example";
const orgCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: ORG_ID },
};
const input = { contextId: "ctx-1", projectId: "proj-1" };

/** Well past the 40-minute stall window. */
const LONG_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000);

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx-1",
		projectId: "proj-1",
		organizationId: ORG_ID,
		type: "FILE",
		extractionStatus: "EXTRACTING",
		updatedAt: LONG_AGO,
		s3Path: "contexts/proj-1/example-brief.pdf",
		sourceTitle: null,
		originalFilename: "example-brief.pdf",
		sourceUrl: null,
		content: "",
		metadata: null,
		urlScope: null,
		urlMaxPages: null,
		urlRefreshMode: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockGetContextById.mockResolvedValue(row());
	mockBackgroundJobFindMany.mockResolvedValue([]);
	mockDecryptApiKey.mockReturnValue("decrypted-fc-key");
	mockGetSearchProviderConfig.mockResolvedValue({
		encryptedApiKey: "k",
		enabled: true,
	});
	mockUpdateContextExtractionStatus.mockResolvedValue(undefined);
	mockTemporalWorkflowStart.mockResolvedValue(undefined);
	mockDescribe.mockResolvedValue({ status: { name: "COMPLETED" } });
	mockProjectContextUpdate.mockResolvedValue(undefined);
	mockProjectContextUpdateMany.mockResolvedValue({ count: 1 });
	mockCreateBackgroundJob.mockResolvedValue("job-1");
	mockFailBackgroundJob.mockResolvedValue(undefined);
});

describe("retryStalled — dispatch", () => {
	it("re-extracts a row with a stored original, as a retry, under a fresh id", async () => {
		const handler = await loadHandler();
		const result = await handler({ input, context: orgCtx });

		expect(result.dispatch).toBe("processing");
		const [name, options] = mockTemporalWorkflowStart.mock.calls[0];
		expect(name).toBe("projectContextProcessingWorkflow");
		expect(options.workflowId).toMatch(
			/^project-context-processing-ctx-1-retry-\d+$/,
		);
		expect(options.args[0]).toMatchObject({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: ORG_ID,
			isRetry: true,
		});
		// A job row for the Job Hub and for the stall clock, on the new id.
		expect(mockCreateBackgroundJob).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "CONTEXT_PROCESSING",
				workflowId: options.workflowId,
				sourceType: "projectContext",
				sourceId: "ctx-1",
				title: "example-brief.pdf",
			}),
		);
		expect(result.workflowId).toBe(options.workflowId);
	});

	it("treats a Google Doc as a stored original, not a live integration", async () => {
		mockGetContextById.mockResolvedValue(
			row({
				type: "INTEGRATION",
				metadata: { source: "google-docs" },
				s3Path: "contexts/proj-1/google-doc.md",
			}),
		);
		const handler = await loadHandler();
		const result = await handler({ input, context: orgCtx });

		expect(result.dispatch).toBe("processing");
	});

	it("crawls a link again and stamps the crawl for the cancel door", async () => {
		mockGetContextById.mockResolvedValue(
			row({
				type: "LINK",
				s3Path: null,
				sourceUrl: "https://example.com/docs",
				sourceTitle: "Example docs",
				urlScope: "PATH_PREFIX",
				urlMaxPages: 50,
			}),
		);
		const handler = await loadHandler();
		const result = await handler({ input, context: orgCtx });

		expect(result.dispatch).toBe("crawl");
		const [name, options] = mockTemporalWorkflowStart.mock.calls[0];
		expect(name).toBe("urlSourceCrawlWorkflow");
		expect(options.workflowId).toMatch(/^url-crawl-ctx-1-retry-\d+$/);
		expect(options.args[0]).toMatchObject({
			contextId: "ctx-1",
			url: "https://example.com/docs",
			scope: "PATH_PREFIX",
			maxPages: 50,
			apiKey: "decrypted-fc-key",
			mode: "manual-resync",
		});
		expect(mockProjectContextUpdate).toHaveBeenCalledWith({
			where: { id: "ctx-1" },
			data: { urlActiveWorkflowId: options.workflowId },
		});
		expect(mockCreateBackgroundJob).not.toHaveBeenCalled();
	});

	it("refuses a link retry while the crawl the row names is still running", async () => {
		mockGetContextById.mockResolvedValue(
			row({
				type: "LINK",
				s3Path: null,
				sourceUrl: "https://example.com/docs",
				urlActiveWorkflowId: "url-crawl-ctx-1-resync-1",
			}),
		);
		mockDescribe.mockResolvedValue({ status: { name: "RUNNING" } });
		const handler = await loadHandler();

		await expect(handler({ input, context: orgCtx })).rejects.toMatchObject(
			{ code: "CONFLICT" },
		);
		expect(mockProjectContextUpdateMany).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});

	it("crawls again when the named crawl is gone from Temporal", async () => {
		mockGetContextById.mockResolvedValue(
			row({
				type: "LINK",
				s3Path: null,
				sourceUrl: "https://example.com/docs",
				urlActiveWorkflowId: "url-crawl-ctx-1-resync-1",
			}),
		);
		mockDescribe.mockRejectedValue(new Error("workflow not found"));
		const handler = await loadHandler();

		const result = await handler({ input, context: orgCtx });

		expect(result.dispatch).toBe("crawl");
	});

	it("refuses a link retry without a Firecrawl key, leaving the row untouched", async () => {
		mockGetContextById.mockResolvedValue(
			row({
				type: "LINK",
				s3Path: null,
				sourceUrl: "https://example.com/docs",
			}),
		);
		mockGetSearchProviderConfig.mockResolvedValue(null);
		const handler = await loadHandler();

		await expect(handler({ input, context: orgCtx })).rejects.toMatchObject(
			{ code: "BAD_REQUEST", data: { code: "FIRECRAWL_NOT_CONFIGURED" } },
		);
		expect(mockProjectContextUpdateMany).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});

	it("embeds a row holding its own text again, without shipping the body", async () => {
		mockGetContextById.mockResolvedValue(
			row({ type: "TEXT", s3Path: null, content: "Example notes" }),
		);
		const handler = await loadHandler();
		const result = await handler({ input, context: orgCtx });

		expect(result.dispatch).toBe("embedding");
		const [name, options] = mockTemporalWorkflowStart.mock.calls[0];
		expect(name).toBe("contextEmbeddingWorkflow");
		expect(options.workflowId).toMatch(/^context-embedding-ctx-1-\d+$/);
		expect(options.args[0]).toMatchObject({
			contextId: "ctx-1",
			type: "TEXT",
		});
		expect(options.args[0]).not.toHaveProperty("content");
	});

	it("refuses a row with nothing stored to retry from", async () => {
		mockGetContextById.mockResolvedValue(
			row({ type: "TEXT", s3Path: null, content: "  " }),
		);
		const handler = await loadHandler();

		await expect(handler({ input, context: orgCtx })).rejects.toMatchObject(
			{ code: "BAD_REQUEST" },
		);
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});

	it("uses a fresh id on every retry", async () => {
		const handler = await loadHandler();
		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValueOnce(1_000);
		await handler({ input, context: orgCtx });
		nowSpy.mockReturnValueOnce(2_000);
		await handler({ input, context: orgCtx });
		nowSpy.mockRestore();

		const ids = mockTemporalWorkflowStart.mock.calls.map(
			([, options]) => options.workflowId,
		);
		expect(ids[0]).not.toBe(ids[1]);
	});
});

describe("retryStalled — the row is restarted cleanly", () => {
	it("claims the row back to PENDING, only as it was read, and clears the dead run's message", async () => {
		const handler = await loadHandler();
		await handler({ input, context: orgCtx });

		expect(mockProjectContextUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "ctx-1",
				updatedAt: LONG_AGO,
				extractionStatus: { in: ["PENDING", "EXTRACTING"] },
			},
			data: { extractionStatus: "PENDING", extractionError: null },
		});
		expect(
			mockProjectContextUpdateMany.mock.invocationCallOrder[0],
		).toBeLessThan(mockTemporalWorkflowStart.mock.invocationCallOrder[0]);
	});

	it("refuses a second retry that lost the claim, starting nothing", async () => {
		// Two presses both passed the checks; the other one's claim moved
		// `updatedAt` first, so this one matches no row.
		mockProjectContextUpdateMany.mockResolvedValue({ count: 0 });
		mockBackgroundJobFindMany.mockResolvedValue([
			{
				workflowId: "project-context-processing-ctx-1",
				heartbeatAt: LONG_AGO,
			},
		]);
		const handler = await loadHandler();

		await expect(handler({ input, context: orgCtx })).rejects.toMatchObject(
			{ code: "CONFLICT" },
		);
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
		expect(mockCreateBackgroundJob).not.toHaveBeenCalled();
		// Claimed before the stale jobs are closed, so a loser closes none.
		expect(mockFailBackgroundJob).not.toHaveBeenCalled();
	});

	it("closes the dead run's job rows, whose heartbeat would keep the banner up", async () => {
		mockGetContextById.mockResolvedValue(row({ updatedAt: new Date() }));
		mockBackgroundJobFindMany.mockResolvedValue([
			{
				workflowId: "project-context-processing-ctx-1",
				heartbeatAt: LONG_AGO,
			},
		]);
		const handler = await loadHandler();
		await handler({ input, context: orgCtx });

		expect(mockBackgroundJobFindMany.mock.calls[0][0].where).toMatchObject({
			projectId: "proj-1",
			kind: "CONTEXT_PROCESSING",
			status: "RUNNING",
			sourceType: "projectContext",
			sourceId: "ctx-1",
		});
		expect(mockFailBackgroundJob).toHaveBeenCalledWith(
			{
				workflowId: "project-context-processing-ctx-1",
				sourceId: "ctx-1",
			},
			expect.objectContaining({ errorClass: "TimedOut" }),
		);
	});

	it("marks the row failed, not processing, when the workflow cannot start", async () => {
		mockTemporalWorkflowStart.mockRejectedValue(new Error("temporal down"));
		const handler = await loadHandler();

		await expect(handler({ input, context: orgCtx })).rejects.toMatchObject(
			{ code: "INTERNAL_SERVER_ERROR" },
		);
		expect(mockUpdateContextExtractionStatus).toHaveBeenLastCalledWith(
			"ctx-1",
			"FAILED",
			expect.objectContaining({
				extractionError: expect.stringContaining("temporal down"),
			}),
		);
	});
});

describe("retryStalled — refusals", () => {
	it("refuses a row still being written, so a live run is never doubled", async () => {
		mockGetContextById.mockResolvedValue(row({ updatedAt: new Date() }));
		const handler = await loadHandler();

		await expect(handler({ input, context: orgCtx })).rejects.toMatchObject(
			{ code: "CONFLICT" },
		);
		expect(mockProjectContextUpdateMany).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});

	it("refuses a stale row whose job is still heartbeating", async () => {
		mockBackgroundJobFindMany.mockResolvedValue([
			{
				workflowId: "project-context-processing-ctx-1",
				heartbeatAt: new Date(),
			},
		]);
		const handler = await loadHandler();

		await expect(handler({ input, context: orgCtx })).rejects.toMatchObject(
			{ code: "CONFLICT" },
		);
		expect(mockFailBackgroundJob).not.toHaveBeenCalled();
	});

	it("refuses a live integration, whose status never moves", async () => {
		mockGetContextById.mockResolvedValue(
			row({
				type: "INTEGRATION",
				s3Path: null,
				extractionStatus: "PENDING",
				metadata: { provider: "SLACK" },
			}),
		);
		const handler = await loadHandler();

		await expect(handler({ input, context: orgCtx })).rejects.toMatchObject(
			{ code: "BAD_REQUEST" },
		);
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});

	it("refuses a row that already settled", async () => {
		mockGetContextById.mockResolvedValue(
			row({ extractionStatus: "COMPLETED" }),
		);
		const handler = await loadHandler();

		await expect(handler({ input, context: orgCtx })).rejects.toMatchObject(
			{ code: "BAD_REQUEST" },
		);
	});

	it("returns NOT_FOUND for a row outside the caller's tenant, filtered by the session's org", async () => {
		mockGetContextById.mockResolvedValue(null);
		const handler = await loadHandler();

		await expect(handler({ input, context: orgCtx })).rejects.toMatchObject(
			{ code: "NOT_FOUND" },
		);
		expect(mockGetContextById).toHaveBeenCalledWith("ctx-1", "proj-1", {
			userId: "user-1",
			organizationId: ORG_ID,
		});
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});

	it("refuses a caller without project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const handler = await loadHandler();

		await expect(handler({ input, context: orgCtx })).rejects.toMatchObject(
			{ code: "FORBIDDEN" },
		);
		expect(mockGetContextById).not.toHaveBeenCalled();
	});
});

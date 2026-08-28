/**
 * Regression tests for the extraction status of Notion-bound PRD contexts
 * (Fizzy #2228, R13).
 *
 * Before this fix: both bind procedures embedded the page inline via
 * `embedProjectContext` instead of starting `contextEmbeddingWorkflow`, and
 * that helper writes only `qdrantId` / `embeddedAt` — the `extractionStatus`
 * write lives in `embedSingleContextActivity`, which this path never reaches.
 * So an INTEGRATION row holding several kilobytes of real Notion text sat on
 * the schema default `PENDING` for the life of the row, with nothing
 * downstream able to advance it (the bulk `contexts.embed` repair endpoint
 * skips `type: "INTEGRATION"` outright). Readiness evidence counts only
 * `COMPLETED` context sources, so an indexed PRD counted for nothing.
 *
 * After this fix: a stored vector advances the row to `COMPLETED` and clears
 * any stale `extractionError`; a reported embedding failure records the
 * indexing failure instead; and a call that stored no vector leaves the status
 * alone rather than claiming a readiness the project has not earned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockCreateContext,
	mockGetContextById,
	mockGetDataConnectionById,
	mockGetWorkspaceDocumentWithChunks,
	mockRecordContextIndexingFailure,
	mockUpdateContextExtractionStatus,
	mockEmbedProjectContext,
	mockDeleteProjectContext,
	mockGetRAGProviderConfig,
	mockProjectFindFirst,
	mockProjectUpdate,
	mockSyncedResourceFindFirst,
	mockProjectContextUpdate,
} = vi.hoisted(() => ({
	mockCreateContext: vi.fn(),
	mockGetContextById: vi.fn(),
	mockGetDataConnectionById: vi.fn(),
	mockGetWorkspaceDocumentWithChunks: vi.fn(),
	mockRecordContextIndexingFailure: vi.fn(),
	mockUpdateContextExtractionStatus: vi.fn(),
	mockEmbedProjectContext: vi.fn(),
	mockDeleteProjectContext: vi.fn(),
	mockGetRAGProviderConfig: vi.fn(),
	mockProjectFindFirst: vi.fn(),
	mockProjectUpdate: vi.fn(),
	mockSyncedResourceFindFirst: vi.fn(),
	mockProjectContextUpdate: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findFirst: mockProjectFindFirst,
			findUnique: vi.fn(),
			update: mockProjectUpdate,
		},
		projectContext: {
			findUnique: vi.fn(),
			update: mockProjectContextUpdate,
		},
		syncedResource: { findFirst: mockSyncedResourceFindFirst },
	},
	createContext: mockCreateContext,
	deleteContext: vi.fn(),
	getContextById: mockGetContextById,
	getDataConnectionById: mockGetDataConnectionById,
	getWorkspaceDocumentWithChunks: mockGetWorkspaceDocumentWithChunks,
	hasProjectAccess: vi.fn().mockResolvedValue(true),
	recordContextIndexingFailure: mockRecordContextIndexingFailure,
	updateContextExtractionStatus: mockUpdateContextExtractionStatus,
}));

vi.mock("@repo/rag", () => ({
	deleteProjectContext: mockDeleteProjectContext,
	embedProjectContext: mockEmbedProjectContext,
}));

vi.mock("@repo/ai", () => ({
	getRAGProviderConfig: mockGetRAGProviderConfig,
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

type SyncHandler = (args: {
	input: {
		projectId: string;
		organizationId?: string | null;
		connectionId: string;
		resourceId: string;
	};
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

type BindHandler = (args: {
	input: {
		projectId: string;
		organizationId?: string | null;
		connectionId: string;
		notionPageId: string;
		notionTitle: string;
		notionUrl: string;
	};
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

async function loadSyncHandler(): Promise<SyncHandler> {
	const mod = await import("../sync-notion-prd");
	return (mod.syncPrdSourceProcedure as unknown as { handler: SyncHandler })
		.handler;
}

async function loadBindHandler(): Promise<BindHandler> {
	const mod = await import("../sync-notion-prd");
	return (mod.bindNotionPageProcedure as unknown as { handler: BindHandler })
		.handler;
}

const callerContext = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

/**
 * Roughly the size of the stuck rows this fix was written for. Already
 * trimmed, because `buildWorkspaceDocumentContent` trims what it reads and the
 * assertions below compare against the stored value.
 */
const NOTION_PAGE_TEXT = "Product requirements.\n".repeat(200).trim();

const syncInput = {
	projectId: "proj-1",
	organizationId: "org-1",
	connectionId: "conn-1",
	resourceId: "res-1",
};

beforeEach(() => {
	vi.clearAllMocks();

	mockProjectFindFirst.mockResolvedValue({
		id: "proj-1",
		organizationId: "org-1",
		prdSourceContextId: null,
	});
	mockGetDataConnectionById.mockResolvedValue({
		id: "conn-1",
		provider: "NOTION",
		accessToken: "token-1",
	});
	mockSyncedResourceFindFirst.mockResolvedValue({
		id: "res-1",
		title: "Requirements",
		externalId: "page-1",
		externalPath: "https://example.com/page-1",
		metadata: { url: "https://example.com/page-1" },
		documentId: "doc-1",
	});
	mockGetWorkspaceDocumentWithChunks.mockResolvedValue({
		id: "doc-1",
		filename: "Requirements",
		extractedText: NOTION_PAGE_TEXT,
		chunks: [],
	});
	mockGetContextById.mockResolvedValue(null);
	mockCreateContext.mockResolvedValue({ id: "ctx-new" });
	mockGetRAGProviderConfig.mockResolvedValue({ apiKey: "key-1" });
	mockEmbedProjectContext.mockResolvedValue({
		success: true,
		qdrantId: "qdrant-1",
		chunksCreated: 3,
	});
	mockUpdateContextExtractionStatus.mockResolvedValue({ id: "ctx-new" });
	mockRecordContextIndexingFailure.mockResolvedValue({ id: "ctx-new" });
	mockProjectContextUpdate.mockResolvedValue({ id: "ctx-existing" });
	mockProjectUpdate.mockResolvedValue({ id: "proj-1" });
});

describe("syncPrdSourceProcedure — extraction status", () => {
	it("advances a newly created integration context holding content to COMPLETED", async () => {
		const handler = await loadSyncHandler();

		await handler({ input: syncInput, context: callerContext });

		expect(mockCreateContext).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "INTEGRATION",
				content: NOTION_PAGE_TEXT,
			}),
		);
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-new",
			"COMPLETED",
			{ extractionError: null },
		);
		expect(mockRecordContextIndexingFailure).not.toHaveBeenCalled();
	});

	it("records an indexing failure instead of COMPLETED when the embed reports failure", async () => {
		mockEmbedProjectContext.mockResolvedValueOnce({
			success: false,
			error: "Embedding provider unavailable",
		});
		const handler = await loadSyncHandler();

		await handler({ input: syncInput, context: callerContext });

		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
		expect(mockRecordContextIndexingFailure).toHaveBeenCalledWith(
			"ctx-new",
			expect.stringContaining("Embedding provider unavailable"),
		);
	});

	it("does not mark the context successful when the embed stored no vector", async () => {
		// What `embedProjectContext` returns for content it decided there was
		// nothing to embed: resolved, but no point was written. Calling that
		// COMPLETED is the lying-pill bug the INTEGRATION wiring was fixed for.
		mockEmbedProjectContext.mockResolvedValueOnce({
			success: true,
			chunksCreated: 0,
		});
		const handler = await loadSyncHandler();

		await handler({ input: syncInput, context: callerContext });

		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
		expect(mockRecordContextIndexingFailure).not.toHaveBeenCalled();
	});

	it("advances an existing pending row at the point a resync populates its content", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			organizationId: "org-1",
			prdSourceContextId: "ctx-existing",
		});
		mockGetContextById.mockResolvedValue({
			id: "ctx-existing",
			qdrantId: null,
			extractionStatus: "PENDING",
		});
		mockEmbedProjectContext.mockResolvedValueOnce({
			success: true,
			qdrantId: "qdrant-2",
			chunksCreated: 3,
		});
		const handler = await loadSyncHandler();

		await handler({ input: syncInput, context: callerContext });

		expect(mockCreateContext).not.toHaveBeenCalled();
		expect(mockProjectContextUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "ctx-existing" },
				data: expect.objectContaining({ content: NOTION_PAGE_TEXT }),
			}),
		);
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-existing",
			"COMPLETED",
			{ extractionError: null },
		);
	});
});

describe("bindNotionPageProcedure — extraction status", () => {
	it("advances a directly bound page holding content to COMPLETED", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				results: [
					{
						type: "paragraph",
						has_children: false,
						paragraph: {
							rich_text: [{ plain_text: NOTION_PAGE_TEXT }],
						},
					},
				],
				has_more: false,
				next_cursor: null,
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		try {
			const handler = await loadBindHandler();

			await handler({
				input: {
					projectId: "proj-1",
					organizationId: "org-1",
					connectionId: "conn-1",
					notionPageId: "page-1",
					notionTitle: "Requirements",
					notionUrl: "https://example.com/page-1",
				},
				context: callerContext,
			});

			expect(mockCreateContext).toHaveBeenCalledWith(
				expect.objectContaining({ type: "INTEGRATION" }),
			);
			expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
				"ctx-new",
				"COMPLETED",
				{ extractionError: null },
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

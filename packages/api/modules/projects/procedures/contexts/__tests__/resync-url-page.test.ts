/**
 * Unit tests for `resyncUrlPageProcedure` — per-page retry for
 * PATH_PREFIX URL sources.
 *
 * Covers:
 *   - Happy path: child row flipped to PENDING, workflow started with
 *     `mode: 'retry-single-page'` + the page's URL.
 *   - Firecrawl revocation surfaces the SAME BAD_REQUEST payload as
 *     `resyncUrlSource` so the dialog can re-use its notice card.
 *   - Cross-tenant page id → NOT_FOUND (child row XOR filter).
 *   - Cross-tenant parent context id → NOT_FOUND.
 *   - Forbidden when caller has no project access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockGetContextById,
	mockGetSearchProviderConfig,
	mockProjectContextUrlPageFindFirst,
	mockProjectContextUrlPageUpdate,
	mockOrgFindUnique,
	mockTemporalWorkflowStart,
	mockDecryptApiKey,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockGetContextById: vi.fn(),
	mockGetSearchProviderConfig: vi.fn(),
	mockProjectContextUrlPageFindFirst: vi.fn(),
	mockProjectContextUrlPageUpdate: vi.fn(),
	mockOrgFindUnique: vi.fn(),
	mockTemporalWorkflowStart: vi.fn(),
	mockDecryptApiKey: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		organization: { findUnique: mockOrgFindUnique },
		projectContextUrlPage: {
			findFirst: mockProjectContextUrlPageFindFirst,
			update: mockProjectContextUrlPageUpdate,
		},
	},
	getContextById: mockGetContextById,
	getSearchProviderConfig: mockGetSearchProviderConfig,
	hasProjectAccess: mockHasProjectAccess,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mockTemporalWorkflowStart },
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

type ResyncPageInput = {
	pageId: string;
	parentContextId: string;
	projectId: string;
	organizationId?: string | null;
};

type Handler = (args: {
	input: ResyncPageInput;
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../resync-url-page");
	return (mod.resyncUrlPageProcedure as unknown as { handler: Handler })
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
	mockDecryptApiKey.mockReturnValue("decrypted-fc-key");
	mockGetContextById.mockResolvedValue({
		id: "ctx-1",
		projectId: "proj-1",
		type: "LINK",
		sourceTitle: "Help Center",
		sourceUrl: "https://example.com/docs",
		urlScope: "PATH_PREFIX",
		urlMaxPages: 100,
		urlRefreshMode: "WEEKLY",
	});
	mockGetSearchProviderConfig.mockResolvedValue({
		encryptedApiKey: "k",
		endpoint: null,
		enabled: true,
		source: "user",
	});
	mockProjectContextUrlPageFindFirst.mockResolvedValue({
		id: "page-1",
		pageUrl: "https://example.com/docs/article-1",
		parentContextId: "ctx-1",
	});
	mockProjectContextUrlPageUpdate.mockResolvedValue(undefined);
	mockTemporalWorkflowStart.mockResolvedValue(undefined);
});

describe("resyncUrlPage — happy path", () => {
	it("flips the child row to PENDING and starts retry-single-page workflow", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: {
				pageId: "page-1",
				parentContextId: "ctx-1",
				projectId: "proj-1",
			},
			context: personalCtx,
		});

		// Child row optimistically marked PENDING + error cleared.
		expect(mockProjectContextUrlPageUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "page-1" },
				data: expect.objectContaining({
					extractionStatus: "PENDING",
					extractionError: null,
				}),
			}),
		);

		// Workflow started by string name with the deterministic mode +
		// retryPageUrl set to the page's actual URL.
		expect(mockTemporalWorkflowStart).toHaveBeenCalledWith(
			"urlSourceCrawlWorkflow",
			expect.objectContaining({
				taskQueue: "project-documents",
				args: [
					expect.objectContaining({
						contextId: "ctx-1",
						scope: "PATH_PREFIX",
						mode: "retry-single-page",
						retryPageUrl: "https://example.com/docs/article-1",
						apiKey: "decrypted-fc-key",
					}),
				],
			}),
		);

		expect(result).toEqual({
			pageId: "page-1",
			status: "EXTRACTING",
		});
	});

	it("scopes the child-row query by tenant XOR (org context)", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				pageId: "page-1",
				parentContextId: "ctx-1",
				projectId: "proj-1",
				organizationId: "org-1",
			},
			context: orgCtx,
		});

		expect(mockProjectContextUrlPageFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "page-1",
					parentContextId: "ctx-1",
					organizationId: "org-1",
					userId: "user-1",
				}),
			}),
		);
	});
});

describe("resyncUrlPage — Firecrawl revocation", () => {
	it("returns BAD_REQUEST FIRECRAWL_NOT_CONFIGURED when key is revoked", async () => {
		mockGetSearchProviderConfig.mockResolvedValue(null);
		const handler = await loadHandler();

		await expect(
			handler({
				input: {
					pageId: "page-1",
					parentContextId: "ctx-1",
					projectId: "proj-1",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "FIRECRAWL_NOT_CONFIGURED" },
		});

		// Should NOT have flipped status — we bailed before mutating.
		expect(mockProjectContextUrlPageUpdate).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});
});

describe("resyncUrlPage — tenant isolation", () => {
	it("returns NOT_FOUND for cross-tenant parent contextId", async () => {
		mockGetContextById.mockResolvedValue(null);
		const handler = await loadHandler();

		await expect(
			handler({
				input: {
					pageId: "page-1",
					parentContextId: "ctx-other",
					projectId: "proj-1",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mockProjectContextUrlPageFindFirst).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND for cross-tenant pageId", async () => {
		mockProjectContextUrlPageFindFirst.mockResolvedValue(null);
		const handler = await loadHandler();

		await expect(
			handler({
				input: {
					pageId: "page-other",
					parentContextId: "ctx-1",
					projectId: "proj-1",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});

	it("returns FORBIDDEN when caller has no project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const handler = await loadHandler();

		await expect(
			handler({
				input: {
					pageId: "page-1",
					parentContextId: "ctx-1",
					projectId: "proj-1",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		// Pre-flight should NOT touch DB or Temporal.
		expect(mockGetContextById).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});
});

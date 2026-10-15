/**
 * Unit tests for `resyncUrlPageProcedure` — per-page retry for
 * PATH_PREFIX URL sources.
 *
 * Covers:
 *   - Happy path: child row flipped to PENDING, workflow started with
 *     `mode: 'retry-single-page'` + the page's URL.
 *   - The scraper is any enabled scrape-capable provider (a path-prefix
 *     parent's page does not need a crawler), with its endpoint, from the
 *     organization's providers or the user's own — never both.
 *   - No scrape provider surfaces the SAME BAD_REQUEST payload as
 *     `resyncUrlSource` so the dialog can re-use its notice card.
 *   - Cross-tenant page id → NOT_FOUND (child row XOR filter).
 *   - Cross-tenant parent context id → NOT_FOUND.
 *   - Forbidden when caller has no project access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockGetContextById,
	mockGetEnabledOrgProviders,
	mockGetEnabledUserProviders,
	mockProjectContextUrlPageFindFirst,
	mockProjectContextUrlPageUpdate,
	mockOrgFindUnique,
	mockTemporalWorkflowStart,
	mockDecryptApiKey,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockGetContextById: vi.fn(),
	mockGetEnabledOrgProviders: vi.fn(),
	mockGetEnabledUserProviders: vi.fn(),
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
	getEnabledOrganizationSearchProviders: mockGetEnabledOrgProviders,
	getEnabledUserSearchProviders: mockGetEnabledUserProviders,
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

function providerRow(
	providerName: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		providerName,
		encryptedApiKey: `enc-${providerName}`,
		endpoint: null,
		enabled: true,
		isDefault: false,
		priority: 1,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

const pageInput = {
	pageId: "page-1",
	parentContextId: "ctx-1",
	projectId: "proj-1",
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
	mockGetEnabledUserProviders.mockResolvedValue([providerRow("firecrawl")]);
	mockGetEnabledOrgProviders.mockResolvedValue([providerRow("firecrawl")]);
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

		// Child row optimistically marked PENDING. Its error is kept, so a
		// retry whose scrape fails can put the reason back.
		expect(mockProjectContextUrlPageUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "page-1" },
				data: { extractionStatus: "PENDING" },
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
						providerName: "firecrawl",
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

describe("resyncUrlPage — scraper provider", () => {
	it("retries a path-prefix parent's page with a non-Firecrawl provider when it is the only one", async () => {
		mockGetEnabledUserProviders.mockResolvedValue([providerRow("jina")]);
		mockDecryptApiKey.mockImplementation((v: string) => `dec:${v}`);
		const handler = await loadHandler();

		await handler({ input: pageInput, context: personalCtx });

		const [, options] = mockTemporalWorkflowStart.mock.calls[0] as [
			string,
			{ args: Array<Record<string, unknown>> },
		];
		expect(options.args[0]).toMatchObject({
			scope: "PATH_PREFIX",
			mode: "retry-single-page",
			apiKey: "dec:enc-jina",
			providerName: "jina",
		});
		expect(options.args[0]).not.toHaveProperty("providerEndpoint");
	});

	it("passes the Cloudflare account endpoint along with the provider", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			providerRow("cloudflare", { endpoint: "account-123" }),
		]);
		const handler = await loadHandler();

		await handler({
			input: { ...pageInput, organizationId: "org-1" },
			context: orgCtx,
		});

		expect(mockTemporalWorkflowStart).toHaveBeenCalledWith(
			"urlSourceCrawlWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						providerName: "cloudflare",
						providerEndpoint: "account-123",
					}),
				],
			}),
		);
	});

	it("reads the user's providers, never the organization's, with no organization", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			providerRow("firecrawl"),
		]);
		mockGetEnabledUserProviders.mockResolvedValue([providerRow("tavily")]);
		const handler = await loadHandler();

		await handler({ input: pageInput, context: personalCtx });

		expect(mockGetEnabledUserProviders).toHaveBeenCalledWith("user-1");
		expect(mockGetEnabledOrgProviders).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).toHaveBeenCalledWith(
			"urlSourceCrawlWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ providerName: "tavily" })],
			}),
		);
	});

	it("reads the organization's providers, never the user's, inside an organization", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([providerRow("exa")]);
		mockGetEnabledUserProviders.mockResolvedValue([
			providerRow("firecrawl"),
		]);
		const handler = await loadHandler();

		await handler({
			input: { ...pageInput, organizationId: "org-1" },
			context: orgCtx,
		});

		expect(mockGetEnabledOrgProviders).toHaveBeenCalledWith("org-1");
		expect(mockGetEnabledUserProviders).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).toHaveBeenCalledWith(
			"urlSourceCrawlWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ providerName: "exa" })],
			}),
		);
	});

	it("returns BAD_REQUEST SCRAPE_PROVIDER_NOT_CONFIGURED when no provider is enabled", async () => {
		mockGetEnabledUserProviders.mockResolvedValue([]);
		const handler = await loadHandler();

		await expect(
			handler({ input: pageInput, context: personalCtx }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "SCRAPE_PROVIDER_NOT_CONFIGURED" },
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

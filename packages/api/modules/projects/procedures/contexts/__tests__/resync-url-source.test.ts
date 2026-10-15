/**
 * Unit tests for `resyncUrlSourceProcedure` — URL Context Sources spec §6.3.
 *
 * Covers:
 *   - Status flips to PENDING before workflow start.
 *   - Workflow started with `mode: "manual-resync"` by string name.
 *   - The scraper is resolved like `processLink` resolves it: any enabled
 *     scrape-capable provider (not only Firecrawl) is passed to the workflow
 *     with its endpoint, organization providers and user providers are never
 *     mixed, and a path-prefix source needs a crawl-capable one.
 *   - No usable provider surfaces the SAME BAD_REQUEST payload as the dialog
 *     so the UI can re-use the notice card.
 *   - NOT_FOUND for cross-tenant addressing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockGetContextById,
	mockGetEnabledOrgProviders,
	mockGetEnabledUserProviders,
	mockUpdateContextExtractionStatus,
	mockOrgFindUnique,
	mockProjectContextUpdate,
	mockTemporalWorkflowStart,
	mockDecryptApiKey,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockGetContextById: vi.fn(),
	mockGetEnabledOrgProviders: vi.fn(),
	mockGetEnabledUserProviders: vi.fn(),
	mockUpdateContextExtractionStatus: vi.fn(),
	mockOrgFindUnique: vi.fn(),
	mockProjectContextUpdate: vi.fn(),
	mockTemporalWorkflowStart: vi.fn(),
	mockDecryptApiKey: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		organization: { findUnique: mockOrgFindUnique },
		projectContext: { update: mockProjectContextUpdate },
	},
	getContextById: mockGetContextById,
	getEnabledOrganizationSearchProviders: mockGetEnabledOrgProviders,
	getEnabledUserSearchProviders: mockGetEnabledUserProviders,
	hasProjectAccess: mockHasProjectAccess,
	updateContextExtractionStatus: mockUpdateContextExtractionStatus,
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
	const mod = await import("../resync-url-source");
	return (mod.resyncUrlSourceProcedure as unknown as { handler: Handler })
		.handler;
}

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

const personalCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: undefined },
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
	mockGetEnabledOrgProviders.mockResolvedValue([]);
	mockUpdateContextExtractionStatus.mockResolvedValue(undefined);
	mockTemporalWorkflowStart.mockResolvedValue(undefined);
	mockProjectContextUpdate.mockResolvedValue(undefined);
});

describe("resyncUrlSource — happy path", () => {
	it("flips status to PENDING and starts urlSourceCrawlWorkflow with manual-resync mode", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: { contextId: "ctx-1", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-1",
			"PENDING",
			expect.objectContaining({ extractionError: undefined }),
		);
		expect(mockTemporalWorkflowStart).toHaveBeenCalledWith(
			"urlSourceCrawlWorkflow",
			expect.objectContaining({
				taskQueue: "project-documents",
				args: [
					expect.objectContaining({
						contextId: "ctx-1",
						url: "https://example.com/docs",
						mode: "manual-resync",
					}),
				],
			}),
		);
		expect(result).toEqual({ contextId: "ctx-1", status: "EXTRACTING" });
	});
});

describe("resyncUrlSource — scraper provider", () => {
	it("passes a non-Firecrawl provider to the workflow when it is the only one enabled", async () => {
		mockGetEnabledUserProviders.mockResolvedValue([providerRow("jina")]);
		mockDecryptApiKey.mockImplementation((v: string) => `dec:${v}`);
		const handler = await loadHandler();
		// A single-page source: Jina scrapes but cannot crawl.
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-1",
			type: "LINK",
			sourceTitle: "Help Center",
			sourceUrl: "https://example.com/docs",
			urlScope: "SINGLE_PAGE",
			urlMaxPages: null,
			urlRefreshMode: "ONCE",
		});

		await handler({
			input: { contextId: "ctx-1", projectId: "proj-1" },
			context: personalCtx,
		});

		const [, options] = mockTemporalWorkflowStart.mock.calls[0] as [
			string,
			{ args: Array<Record<string, unknown>> },
		];
		expect(options.args[0]).toMatchObject({
			apiKey: "dec:enc-jina",
			providerName: "jina",
		});
		expect(options.args[0]).not.toHaveProperty("providerEndpoint");
	});

	it("passes the Cloudflare account endpoint along with the provider", async () => {
		mockGetEnabledUserProviders.mockResolvedValue([
			providerRow("cloudflare", { endpoint: "account-123" }),
		]);
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-1",
			type: "LINK",
			sourceUrl: "https://example.com/docs",
			urlScope: "SINGLE_PAGE",
		});
		const handler = await loadHandler();

		await handler({
			input: { contextId: "ctx-1", projectId: "proj-1" },
			context: personalCtx,
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

	it("keeps Firecrawl for the path-prefix source even when another provider ranks first", async () => {
		mockGetEnabledUserProviders.mockResolvedValue([
			providerRow("jina", { isDefault: true }),
			providerRow("firecrawl"),
		]);
		const handler = await loadHandler();

		await handler({
			input: { contextId: "ctx-1", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockTemporalWorkflowStart).toHaveBeenCalledWith(
			"urlSourceCrawlWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ providerName: "firecrawl" })],
			}),
		);
	});

	it("reads the user's providers, never the organization's, with no organization", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([providerRow("exa")]);
		const handler = await loadHandler();

		await handler({
			input: { contextId: "ctx-1", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockGetEnabledUserProviders).toHaveBeenCalledWith("user-1");
		expect(mockGetEnabledOrgProviders).not.toHaveBeenCalled();
	});

	it("reads the organization's providers, never the user's, inside an organization", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([
			providerRow("firecrawl"),
		]);
		mockGetEnabledUserProviders.mockResolvedValue([providerRow("exa")]);
		const handler = await loadHandler();

		await handler({
			input: {
				contextId: "ctx-1",
				projectId: "proj-1",
				organizationId: "org-1",
			},
			context: personalCtx,
		});

		expect(mockGetEnabledOrgProviders).toHaveBeenCalledWith("org-1");
		expect(mockGetEnabledUserProviders).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).toHaveBeenCalledWith(
			"urlSourceCrawlWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ providerName: "firecrawl" })],
			}),
		);
	});

	it("returns BAD_REQUEST SCRAPE_PROVIDER_NOT_CONFIGURED when no provider is enabled", async () => {
		mockGetEnabledUserProviders.mockResolvedValue([]);
		const handler = await loadHandler();

		await expect(
			handler({
				input: { contextId: "ctx-1", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: {
				code: "SCRAPE_PROVIDER_NOT_CONFIGURED",
				settingsPath: "/app/settings/search-providers",
			},
		});

		// Status should NOT have flipped — we bailed before mutating.
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});

	it("returns BAD_REQUEST CRAWL_PROVIDER_NOT_CONFIGURED for a path-prefix source when only Jina is enabled", async () => {
		mockGetEnabledUserProviders.mockResolvedValue([providerRow("jina")]);
		const handler = await loadHandler();

		await expect(
			handler({
				input: { contextId: "ctx-1", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "CRAWL_PROVIDER_NOT_CONFIGURED" },
		});
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
	});

	it("names the organization's settings page when the organization has no provider", async () => {
		mockGetEnabledOrgProviders.mockResolvedValue([]);
		mockOrgFindUnique.mockResolvedValue({ slug: "example-org" });
		const handler = await loadHandler();

		await expect(
			handler({
				input: {
					contextId: "ctx-1",
					projectId: "proj-1",
					organizationId: "org-1",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject({
			data: {
				code: "SCRAPE_PROVIDER_NOT_CONFIGURED",
				settingsPath: "/app/example-org/settings/search-providers",
			},
		});
	});
});

describe("resyncUrlSource — tenant isolation", () => {
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

describe("resyncUrlSource — concurrent-crawl guard", () => {
	// Server-side guard against duplicate workflows. The UI disables the
	// Re-sync button while a crawl is in flight, but a second tab, another
	// teammate, or a curl could still call the procedure. Refuse here rather
	// than spawn a second workflow that races the running one.
	it.each(["PENDING", "EXTRACTING"] as const)(
		"returns CONFLICT when extractionStatus is %s",
		async (status) => {
			mockGetContextById.mockResolvedValue({
				id: "ctx-1",
				projectId: "proj-1",
				type: "LINK",
				sourceTitle: "Help Center",
				sourceUrl: "https://example.com/docs",
				urlScope: "PATH_PREFIX",
				urlMaxPages: 100,
				urlRefreshMode: "WEEKLY",
				extractionStatus: status,
			});
			const handler = await loadHandler();
			await expect(
				handler({
					input: { contextId: "ctx-1", projectId: "proj-1" },
					context: personalCtx,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			// Neither status flip nor workflow start happens on the guard path.
			expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
			expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
		},
	);

	it.each(["COMPLETED", "FAILED"] as const)(
		"allows re-sync when extractionStatus is %s",
		async (status) => {
			mockGetContextById.mockResolvedValue({
				id: "ctx-1",
				projectId: "proj-1",
				type: "LINK",
				sourceTitle: "Help Center",
				sourceUrl: "https://example.com/docs",
				urlScope: "PATH_PREFIX",
				urlMaxPages: 100,
				urlRefreshMode: "WEEKLY",
				extractionStatus: status,
			});
			const handler = await loadHandler();
			await expect(
				handler({
					input: { contextId: "ctx-1", projectId: "proj-1" },
					context: personalCtx,
				}),
			).resolves.toBeDefined();
			expect(mockTemporalWorkflowStart).toHaveBeenCalledOnce();
		},
	);
});

/**
 * Unit tests for `resyncUrlSourceProcedure` — URL Context Sources spec §6.3.
 *
 * Covers:
 *   - Status flips to PENDING before workflow start.
 *   - Workflow started with `mode: "manual-resync"` by string name.
 *   - Firecrawl revocation surfaces the SAME BAD_REQUEST payload as the
 *     dialog so the UI can re-use the notice card.
 *   - NOT_FOUND for cross-tenant addressing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockGetContextById,
	mockGetSearchProviderConfig,
	mockUpdateContextExtractionStatus,
	mockOrgFindUnique,
	mockProjectContextUpdate,
	mockTemporalWorkflowStart,
	mockDecryptApiKey,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockGetContextById: vi.fn(),
	mockGetSearchProviderConfig: vi.fn(),
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
	getSearchProviderConfig: mockGetSearchProviderConfig,
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
	mockGetSearchProviderConfig.mockResolvedValue({
		encryptedApiKey: "k",
		endpoint: null,
		enabled: true,
		source: "user",
	});
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

describe("resyncUrlSource — Firecrawl revocation", () => {
	it("returns BAD_REQUEST FIRECRAWL_NOT_CONFIGURED when key is revoked", async () => {
		mockGetSearchProviderConfig.mockResolvedValue(null);
		const handler = await loadHandler();

		await expect(
			handler({
				input: { contextId: "ctx-1", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "FIRECRAWL_NOT_CONFIGURED" },
		});

		// Status should NOT have flipped — we bailed before mutating.
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
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

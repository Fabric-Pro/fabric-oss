/**
 * Unit tests for `getUrlPageContentProcedure` — URL Context Sources spec §6.5.
 *
 * Covers:
 *   - Returns full `content` (this is the lazy-load procedure).
 *   - NOT_FOUND when the pageId is in another tenant (XOR isolation —
 *     personal user can't read an org-context page).
 *   - No vector payload on the chunk descriptors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockHasProjectAccess, mockUrlPageFindFirst } = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockUrlPageFindFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectContextUrlPage: { findFirst: mockUrlPageFindFirst },
	},
	hasProjectAccess: mockHasProjectAccess,
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
		pageId: string;
		projectId: string;
		organizationId?: string | null;
	};
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../get-url-page-content");
	return (mod.getUrlPageContentProcedure as unknown as { handler: Handler })
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
});

describe("getUrlPageContent — happy path", () => {
	it("returns full content + chunk descriptors WITHOUT vectors", async () => {
		mockUrlPageFindFirst.mockResolvedValue({
			id: "page-1",
			parentContextId: "ctx-1",
			pageUrl: "https://example.com/a",
			pageTitle: "Page A",
			content: "# Heading\n\nLong markdown body...",
			lastFetchedAt: new Date("2026-05-13T00:00:00Z"),
			contentHash: "abc123",
			etag: 'W/"xyz"',
			lastModifiedHeader: "Wed, 13 May 2026 00:00:00 GMT",
			chunkCount: 3,
			qdrantId: "qd-1",
			embeddedAt: new Date("2026-05-13T00:00:01Z"),
			extractionStatus: "COMPLETED",
			extractionError: null,
		});

		const handler = await loadHandler();
		const result = (await handler({
			input: { pageId: "page-1", projectId: "proj-1" },
			context: personalCtx,
		})) as {
			content: string;
			chunks: Array<Record<string, unknown>>;
			[key: string]: unknown;
		};

		expect(result.content).toContain("Long markdown body");
		expect(result.chunks).toHaveLength(1);
		// Each chunk descriptor exposes index / offsets / snippet / qdrantId
		// but NEVER a `vector` field.
		for (const chunk of result.chunks) {
			expect(chunk).not.toHaveProperty("vector");
			expect(chunk).toHaveProperty("qdrantId");
			expect(chunk).toHaveProperty("index");
		}
	});
});

describe("getUrlPageContent — XOR tenant isolation", () => {
	it("returns NOT_FOUND when a personal user addresses an org page", async () => {
		// Simulate that the org-scoped page does not match the personal
		// tenant filter — Prisma findFirst returns null because the
		// `organizationId: null` constraint excludes the org row.
		mockUrlPageFindFirst.mockResolvedValue(null);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { pageId: "org-page-1", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// Verify the tenant filter we sent to Prisma was the personal
		// variant.
		const where = mockUrlPageFindFirst.mock.calls[0]?.[0].where as Record<
			string,
			unknown
		>;
		expect(where.organizationId).toBeNull();
		expect(where.userId).toBe("user-1");
	});

	it("uses the org tenant filter when caller is in org context", async () => {
		mockUrlPageFindFirst.mockResolvedValue({
			id: "org-page-1",
			parentContextId: "ctx-1",
			pageUrl: "https://example.com/a",
			pageTitle: null,
			content: "x",
			lastFetchedAt: new Date(),
			contentHash: "h",
			etag: null,
			lastModifiedHeader: null,
			chunkCount: 0,
			qdrantId: null,
			embeddedAt: null,
			extractionStatus: "COMPLETED",
			extractionError: null,
		});

		const handler = await loadHandler();
		await handler({
			input: {
				pageId: "org-page-1",
				projectId: "proj-1",
				organizationId: "org-1",
			},
			context: orgCtx,
		});

		const where = mockUrlPageFindFirst.mock.calls[0]?.[0].where as Record<
			string,
			unknown
		>;
		expect(where.organizationId).toBe("org-1");
	});
});

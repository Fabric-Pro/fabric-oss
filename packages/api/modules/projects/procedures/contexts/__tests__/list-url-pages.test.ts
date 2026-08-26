/**
 * Unit tests for `listUrlPagesProcedure` — URL Context Sources spec §6.4.
 *
 * Covers:
 *   - `content` is NEVER selected — payload is light enough for the
 *     drawer's 10-row default page.
 *   - Cursor pagination derives `nextCursor` from the tail of `limit + 1`.
 *   - Tenant filter enforces XOR (cross-tenant page → NOT_FOUND on parent).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockGetContextById,
	mockUrlPageFindMany,
	mockUrlPageCount,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockGetContextById: vi.fn(),
	mockUrlPageFindMany: vi.fn(),
	mockUrlPageCount: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectContextUrlPage: {
			findMany: mockUrlPageFindMany,
			count: mockUrlPageCount,
		},
	},
	getContextById: mockGetContextById,
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
		parentContextId: string;
		projectId: string;
		organizationId?: string | null;
		cursor?: string;
		limit?: number;
	};
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../list-url-pages");
	return (mod.listUrlPagesProcedure as unknown as { handler: Handler })
		.handler;
}

const personalCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: undefined },
};

function makeRow(id: string, pageUrl: string) {
	return {
		id,
		pageUrl,
		pageTitle: `Title ${id}`,
		lastFetchedAt: new Date("2026-05-13T00:00:00Z"),
		chunkCount: 5,
		extractionStatus: "COMPLETED",
		extractionError: null,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockGetContextById.mockResolvedValue({
		id: "parent-1",
		projectId: "proj-1",
		type: "LINK",
	});
	mockUrlPageCount.mockResolvedValue(0);
});

describe("listUrlPages — payload shape", () => {
	it("does NOT include `content` in the select clause", async () => {
		mockUrlPageFindMany.mockResolvedValue([
			makeRow("p1", "https://example.com/a"),
			makeRow("p2", "https://example.com/b"),
		]);
		mockUrlPageCount.mockResolvedValue(2);

		const handler = await loadHandler();
		const result = (await handler({
			input: {
				parentContextId: "parent-1",
				projectId: "proj-1",
				limit: 10,
			},
			context: personalCtx,
		})) as { items: Array<Record<string, unknown>>; total: number };

		// Inspect the Prisma `select` we passed in.
		const findManyArgs = mockUrlPageFindMany.mock.calls[0]?.[0] as {
			select: Record<string, boolean>;
		};
		expect(findManyArgs.select).not.toHaveProperty("content");
		expect(findManyArgs.select).toMatchObject({
			id: true,
			pageUrl: true,
			pageTitle: true,
			lastFetchedAt: true,
			chunkCount: true,
			extractionStatus: true,
		});

		// Returned items shouldn't have `content` either.
		for (const item of result.items) {
			expect(item).not.toHaveProperty("content");
		}
		expect(result.total).toBe(2);
	});
});

describe("listUrlPages — cursor pagination", () => {
	it("derives nextCursor from the tail when limit + 1 rows are returned", async () => {
		// 11 rows for limit=10 → hasNext, nextCursor = items[9].id.
		const rows = Array.from({ length: 11 }, (_, i) =>
			makeRow(`p${i}`, `https://example.com/${i}`),
		);
		mockUrlPageFindMany.mockResolvedValue(rows);
		mockUrlPageCount.mockResolvedValue(11);

		const handler = await loadHandler();
		const result = (await handler({
			input: {
				parentContextId: "parent-1",
				projectId: "proj-1",
				limit: 10,
			},
			context: personalCtx,
		})) as { items: unknown[]; nextCursor: string | null };

		expect(result.items).toHaveLength(10);
		expect(result.nextCursor).toBe("p9");

		// take = limit + 1 to detect the next page.
		const args = mockUrlPageFindMany.mock.calls[0]?.[0] as { take: number };
		expect(args.take).toBe(11);
	});

	it("returns nextCursor=null when rows.length <= limit", async () => {
		const rows = [makeRow("p1", "https://example.com/a")];
		mockUrlPageFindMany.mockResolvedValue(rows);
		mockUrlPageCount.mockResolvedValue(1);

		const handler = await loadHandler();
		const result = (await handler({
			input: {
				parentContextId: "parent-1",
				projectId: "proj-1",
				limit: 10,
			},
			context: personalCtx,
		})) as { items: unknown[]; nextCursor: string | null };

		expect(result.items).toHaveLength(1);
		expect(result.nextCursor).toBeNull();
	});
});

describe("listUrlPages — tenant isolation", () => {
	it("returns NOT_FOUND when parent context is in another tenant", async () => {
		mockGetContextById.mockResolvedValue(null);
		const handler = await loadHandler();

		await expect(
			handler({
				input: { parentContextId: "p-other", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

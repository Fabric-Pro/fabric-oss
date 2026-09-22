/**
 * Unit tests for `listContextsProcedure` — duplicate annotation (Fizzy #2619).
 *
 * Each returned row carries `duplicateOfContextId`: the id of the row whose
 * content it duplicates, or null. It is derived from `contentHash` over the
 * rows this procedure returns, with the real `annotateDuplicateContexts`, so:
 *  - a copy points at the row that is kept, and the kept row points nowhere;
 *  - rows without a hash are never marked;
 *  - a row the list hides (a context imported as a document) can never be
 *    the row a visible copy is marked against, because it is not in the set.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListContexts, mockHasProjectAccess } = vi.hoisted(() => ({
	mockListContexts: vi.fn(),
	mockHasProjectAccess: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const { annotateDuplicateContexts } = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/context-duplicates")
	>("@repo/database/prisma/queries/projects/context-duplicates");
	return {
		annotateDuplicateContexts,
		hasProjectAccess: mockHasProjectAccess,
		listContexts: mockListContexts,
	};
});

vi.mock("@repo/database/prisma/zod", () => ({
	ProjectContextTypeSchema: { optional: () => ({}) },
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
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Row = {
	id: string;
	contentHash: string | null;
	sourcePath: string | null;
	createdAt: Date;
};

type Handler = (args: {
	input: { projectId: string; organizationId?: string | null };
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<{
	contexts: Array<Row & { duplicateOfContextId: string | null }>;
	total: number;
	hasMore: boolean;
}>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../list-contexts");
	return (mod.listContextsProcedure as unknown as { handler: Handler })
		.handler;
}

const orgCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

function row(
	id: string,
	contentHash: string | null,
	createdAt: string,
	sourcePath: string | null = null,
): Row {
	return { id, contentHash, sourcePath, createdAt: new Date(createdAt) };
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
});

describe("listContexts procedure — duplicateOfContextId", () => {
	it("marks each copy with the row it duplicates and leaves the rest null", async () => {
		mockListContexts.mockResolvedValue({
			contexts: [
				row("copy-2", "h-spec", "2026-03-03T00:00:00Z"),
				row("copy-1", "h-spec", "2026-03-02T00:00:00Z"),
				row("original", "h-spec", "2026-03-01T00:00:00Z"),
				row("unique", "h-other", "2026-02-01T00:00:00Z"),
				row("pending-a", null, "2026-02-02T00:00:00Z"),
				row("pending-b", null, "2026-02-03T00:00:00Z"),
			],
			total: 6,
			hasMore: false,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "proj-1" },
			context: orgCtx,
		});

		const marks = Object.fromEntries(
			result.contexts.map((ctx) => [ctx.id, ctx.duplicateOfContextId]),
		);
		expect(marks).toEqual({
			"copy-2": "original",
			"copy-1": "original",
			original: null,
			unique: null,
			"pending-a": null,
			"pending-b": null,
		});
		// Nothing else about the response changes.
		expect(result.total).toBe(6);
		expect(result.hasMore).toBe(false);
		expect(result.contexts.map((ctx) => ctx.id)).toEqual([
			"copy-2",
			"copy-1",
			"original",
			"unique",
			"pending-a",
			"pending-b",
		]);
	});

	it("keeps a synced file over an older manual upload", async () => {
		mockListContexts.mockResolvedValue({
			contexts: [
				row("synced", "h1", "2026-05-01T00:00:00Z", "docs/guide.md"),
				row("upload", "h1", "2026-01-01T00:00:00Z"),
			],
			total: 2,
			hasMore: false,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "proj-1" },
			context: orgCtx,
		});

		const byId = new Map(result.contexts.map((ctx) => [ctx.id, ctx]));
		expect(byId.get("synced")?.duplicateOfContextId).toBeNull();
		expect(byId.get("upload")?.duplicateOfContextId).toBe("synced");
	});

	it("annotates only the rows the list returns (linked-document rows excluded)", async () => {
		// The older row with the same hash is imported as a document, so the
		// query excludes it; the visible row must not be marked against it.
		mockListContexts.mockResolvedValue({
			contexts: [row("visible", "h1", "2026-04-01T00:00:00Z")],
			total: 1,
			hasMore: false,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "proj-1" },
			context: orgCtx,
		});

		expect(mockListContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				excludeLinkedDocuments: true,
				limit: "none",
			}),
		);
		expect(result.contexts[0]?.duplicateOfContextId).toBeNull();
	});

	it("refuses a caller without project access before listing anything", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		const handler = await loadHandler();
		await expect(
			handler({ input: { projectId: "proj-1" }, context: orgCtx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockListContexts).not.toHaveBeenCalled();
	});
});

/**
 * Tests for searchCodeFilesProcedure
 *
 * Covers:
 * - Fuzzy search by file path (case-insensitive)
 * - Empty results when no code index exists
 * - Empty results when no files match
 * - Result limit (max 10)
 *
 * Project-access enforcement is handled by `requireProjectPermission`
 * middleware and covered by middleware tests, not here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mockGetProjectCodeIndexes } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockGetProjectCodeIndexes: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectCodeIndexes: (...args: unknown[]) =>
		mockGetProjectCodeIndexes(...args),
	AI_PROVIDER_METADATA: {},
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

/** The procedure now merges every connected repo's manifest — wrap the manifest
 * in a single per-repo index row. */
function indexRows(fileManifest: unknown) {
	return [{ fileManifest }];
}

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.searchCodeFiles = fn;
			return {
				_handler: fn,
				_input: (chainable as { _input?: unknown })._input,
			};
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		requirePermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

// Register the handler.
import "../search-code-files";

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

function makeManifestItem(path: string, lang?: string, size?: number) {
	return { path, language: lang, size };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("searchCodeFilesProcedure — fuzzy search", () => {
	it("returns files matching query (case-insensitive)", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue(
			indexRows([
				makeManifestItem("src/utils/helper.ts", "typescript", 1200),
				makeManifestItem(
					"src/components/Button.tsx",
					"typescript",
					3400,
				),
				makeManifestItem("README.md", "markdown", 500),
			]),
		);

		const result = (await handlers.searchCodeFiles({
			input: {
				projectId: "proj-1",
				query: "button",
				organizationId: null,
			},
			context: ctx,
		})) as { files: Array<{ path: string }> };

		expect(result.files).toHaveLength(1);
		expect(result.files[0].path).toBe("src/components/Button.tsx");
	});

	it("matches partial path segments", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue(
			indexRows([
				makeManifestItem("src/utils/auth/login.ts"),
				makeManifestItem("src/utils/auth/logout.ts"),
				makeManifestItem("src/utils/helpers.ts"),
			]),
		);

		const result = (await handlers.searchCodeFiles({
			input: { projectId: "proj-1", query: "auth", organizationId: null },
			context: ctx,
		})) as { files: Array<{ path: string }> };

		expect(result.files).toHaveLength(2);
		expect(result.files.map((f) => f.path)).toContain(
			"src/utils/auth/login.ts",
		);
		expect(result.files.map((f) => f.path)).toContain(
			"src/utils/auth/logout.ts",
		);
	});

	it("limits results to 10 files", async () => {
		const manifest = Array.from({ length: 25 }, (_, i) =>
			makeManifestItem(`src/file-${i}.ts`),
		);
		mockGetProjectCodeIndexes.mockResolvedValue(indexRows(manifest));

		const result = (await handlers.searchCodeFiles({
			input: { projectId: "proj-1", query: "file", organizationId: null },
			context: ctx,
		})) as { files: unknown[] };

		expect(result.files).toHaveLength(10);
	});
});

describe("searchCodeFilesProcedure — empty results", () => {
	it("returns empty array when no code index exists", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue([]);

		const result = (await handlers.searchCodeFiles({
			input: {
				projectId: "proj-1",
				query: "anything",
				organizationId: null,
			},
			context: ctx,
		})) as { files: unknown[] };

		expect(result.files).toEqual([]);
	});

	it("returns empty array when no files match", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue(
			indexRows([
				makeManifestItem("src/main.ts"),
				makeManifestItem("src/app.ts"),
			]),
		);

		const result = (await handlers.searchCodeFiles({
			input: {
				projectId: "proj-1",
				query: "nonexistent",
				organizationId: null,
			},
			context: ctx,
		})) as { files: unknown[] };

		expect(result.files).toEqual([]);
	});

	it("returns empty array when manifest is empty", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue(indexRows([]));

		const result = (await handlers.searchCodeFiles({
			input: { projectId: "proj-1", query: "test", organizationId: null },
			context: ctx,
		})) as { files: unknown[] };

		expect(result.files).toEqual([]);
	});
});

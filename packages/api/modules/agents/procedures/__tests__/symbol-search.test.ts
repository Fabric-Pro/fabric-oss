/**
 * Tests for symbolSearchProcedure
 *
 * Covers:
 * - Fuzzy match by symbol name (case-insensitive)
 * - Type filter (function, class, etc.)
 * - Tenant isolation via hasProjectAccess + XOR in searchCodeSymbols
 * - Empty results when no symbols match
 * - Result limit (max 20)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, uses, mockHasProjectAccess, mockSearchCodeSymbols } =
	vi.hoisted(() => ({
		handlers: {} as Record<string, (...args: unknown[]) => unknown>,
		uses: [] as unknown[],
		mockHasProjectAccess: vi.fn(),
		mockSearchCodeSymbols: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	searchCodeSymbols: (...args: unknown[]) => mockSearchCodeSymbols(...args),
	AI_PROVIDER_METADATA: {},
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: (...args: unknown[]) => {
			uses.push(...args);
			return chainable;
		},
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.symbolSearch = fn;
			return {
				_handler: fn,
				_input: (chainable as { _input?: unknown })._input,
			};
		},
	});

	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;

	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: (perm: string) => {
			uses.push({ requireProjectPermission: perm });
			return (c: unknown) => c;
		},
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

// Register the handler.
import "../symbol-search";

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

function makeSymbol(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: "sym-1",
		name: "myFunction",
		type: "function",
		filePath: "src/utils.ts",
		lineStart: 10,
		lineEnd: 20,
		signature: "function myFunction(a: string): number",
		language: "typescript",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Note: do NOT clear `uses` here — it is populated once at module load time
	// and checked by the permission wiring test.
});

describe("symbolSearchProcedure — fuzzy match", () => {
	it("returns symbols matching name (case-insensitive)", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockSearchCodeSymbols.mockResolvedValue([
			makeSymbol({ id: "sym-1", name: "authenticateUser" }),
			makeSymbol({ id: "sym-2", name: "authorizeUser" }),
		]);

		const result = (await handlers.symbolSearch({
			input: {
				projectId: "proj-1",
				query: "auth",
				organizationId: null,
			},
			context: ctx,
		})) as { symbols: Array<{ name: string }> };

		expect(result.symbols).toHaveLength(2);
		expect(mockSearchCodeSymbols).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				query: "auth",
				userId: "user-1",
				organizationId: null,
				limit: 20,
			}),
		);
	});

	it("returns symbols with all mapped fields", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockSearchCodeSymbols.mockResolvedValue([
			makeSymbol({
				id: "sym-1",
				name: "calculateSum",
				type: "function",
				filePath: "src/math.ts",
				lineStart: 5,
				lineEnd: 15,
				signature:
					"function calculateSum(a: number, b: number): number",
				language: "typescript",
			}),
		]);

		const result = (await handlers.symbolSearch({
			input: {
				projectId: "proj-1",
				query: "calc",
				organizationId: null,
			},
			context: ctx,
		})) as {
			symbols: Array<{
				id: string;
				name: string;
				type: string;
				filePath: string;
				lineStart: number;
				lineEnd: number;
				signature: string;
				language: string;
			}>;
		};

		const sym = result.symbols[0];
		expect(sym.id).toBe("sym-1");
		expect(sym.name).toBe("calculateSum");
		expect(sym.type).toBe("function");
		expect(sym.filePath).toBe("src/math.ts");
		expect(sym.lineStart).toBe(5);
		expect(sym.lineEnd).toBe(15);
		expect(sym.signature).toBe(
			"function calculateSum(a: number, b: number): number",
		);
		expect(sym.language).toBe("typescript");
	});
});

describe("symbolSearchProcedure — type filter", () => {
	it("passes type to searchCodeSymbols when provided", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockSearchCodeSymbols.mockResolvedValue([
			makeSymbol({ name: "MyClass", type: "class" }),
		]);

		await handlers.symbolSearch({
			input: {
				projectId: "proj-1",
				query: "My",
				type: "class",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mockSearchCodeSymbols).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "My",
				type: "class",
			}),
		);
	});

	it("passes null type when not provided", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockSearchCodeSymbols.mockResolvedValue([]);

		await handlers.symbolSearch({
			input: {
				projectId: "proj-1",
				query: "foo",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mockSearchCodeSymbols).toHaveBeenCalledWith(
			expect.objectContaining({
				type: null,
			}),
		);
	});
});

describe("symbolSearchProcedure — tenant isolation", () => {
	it("throws FORBIDDEN when user has no project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		await expect(
			handlers.symbolSearch({
				input: {
					projectId: "proj-1",
					query: "auth",
					organizationId: null,
				},
				context: ctx,
			}),
		).rejects.toThrow(/don't have access/i);

		expect(mockSearchCodeSymbols).not.toHaveBeenCalled();
	});

	it("passes organizationId to hasProjectAccess and searchCodeSymbols", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockSearchCodeSymbols.mockResolvedValue([]);

		await handlers.symbolSearch({
			input: {
				projectId: "proj-1",
				query: "test",
				organizationId: "org-1",
			},
			context: ctx,
		});

		expect(mockHasProjectAccess).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
			"org-1",
		);
		expect(mockSearchCodeSymbols).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
			}),
		);
	});

	it("uses XOR pattern with organizationId: null for personal context", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockSearchCodeSymbols.mockResolvedValue([]);

		await handlers.symbolSearch({
			input: {
				projectId: "proj-1",
				query: "test",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mockSearchCodeSymbols).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: null,
				userId: "user-1",
			}),
		);
	});
});

describe("symbolSearchProcedure — empty results", () => {
	it("returns empty array when no symbols match", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		mockSearchCodeSymbols.mockResolvedValue([]);

		const result = (await handlers.symbolSearch({
			input: {
				projectId: "proj-1",
				query: "nonexistent",
				organizationId: null,
			},
			context: ctx,
		})) as { symbols: unknown[] };

		expect(result.symbols).toEqual([]);
	});
});

describe("symbolSearchProcedure — permission wiring", () => {
	it("requires the PROJECT_READ permission", () => {
		const found = uses.some(
			(u) =>
				typeof u === "object" &&
				u !== null &&
				(u as { requireProjectPermission?: string })
					.requireProjectPermission === "PROJECT_READ",
		);
		expect(found).toBe(true);
	});
});

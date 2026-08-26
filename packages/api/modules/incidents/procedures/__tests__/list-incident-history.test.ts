/**
 * Tests for listIncidentHistoryProcedure (server-side paginated).
 *
 * Covers:
 *   - happy path: returns the merged `items` page + `total` from the DB
 *     helper, and echoes `page` + `pageSize`. RESOLVED rows survive (the
 *     whole point of the history view vs the active-only banner).
 *   - default values: sinceDays=30, status=all, source=all, page=1,
 *     pageSize=25 forwarded to the helper.
 *   - input gate: rejects sinceDays outside 1..365, page < 1, and any
 *     pageSize not in {25,50,100}; accepts the status + source enums.
 *
 * NOTE: admin authorization is enforced by `adminProcedure`, which is mocked
 * here (every chained method returns the chain stub). The role gate itself is
 * covered by the admin-procedure tests in `packages/api/orpc/procedures.ts`.
 * To prove the admin gate is wired (not, say, `protectedProcedure`), we assert
 * the module imports `adminProcedure` and not `protectedProcedure`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListIncidentHistory } = vi.hoisted(() => ({
	mockListIncidentHistory: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listIncidentHistory: (...args: unknown[]) =>
		mockListIncidentHistory(...args),
}));

const usedProcedureNames: string[] = [];

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			// Stash the Zod schema so we can exercise the input gate directly.
			(chainable as { _inputSchema?: unknown })._inputSchema = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({
			_handler: fn,
			_inputSchema: (chainable as { _inputSchema?: unknown })
				._inputSchema,
		}),
	});
	return {
		get adminProcedure() {
			usedProcedureNames.push("adminProcedure");
			return chainable;
		},
		get protectedProcedure() {
			usedProcedureNames.push("protectedProcedure");
			return chainable;
		},
	};
});

const adminCtx = {
	user: { id: "admin-1", role: "admin" },
	session: { id: "session-1", activeOrganizationId: null },
};

type HandlerInput = {
	sinceDays?: number;
	status?: string;
	source?: string;
	page?: number;
	pageSize?: number;
};

type Loaded = {
	handler: (args: {
		input: HandlerInput;
		context: typeof adminCtx;
	}) => Promise<{
		items: unknown[];
		total: number;
		page: number;
		pageSize: number;
	}>;
	inputSchema: {
		parse: (v: unknown) => unknown;
	};
};

async function load(): Promise<Loaded> {
	const mod = await import("../list-incident-history");
	const proc = mod.listIncidentHistoryProcedure as unknown as {
		_handler: Loaded["handler"];
		_inputSchema: Loaded["inputSchema"];
	};
	return { handler: proc._handler, inputSchema: proc._inputSchema };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	usedProcedureNames.length = 0;
});

describe("listIncidentHistoryProcedure", () => {
	it("returns the merged items page (incl. RESOLVED rows) + total and echoes page/pageSize", async () => {
		mockListIncidentHistory.mockResolvedValue({
			items: [
				{ id: "e1", kind: "errorRate", status: "FIRING" },
				{ id: "i1", kind: "integration", status: "RESOLVED" },
				{ id: "c1", kind: "component", status: "ACKNOWLEDGED" },
			],
			total: 42,
		});

		const { handler } = await load();
		const result = await handler({
			input: {
				sinceDays: 30,
				status: "all",
				source: "all",
				page: 1,
				pageSize: 25,
			},
			context: adminCtx,
		});

		expect(mockListIncidentHistory).toHaveBeenCalledWith({
			sinceDays: 30,
			status: "all",
			source: "all",
			page: 1,
			pageSize: 25,
		});
		expect(result.items).toHaveLength(3);
		// RESOLVED rows must survive — the active banner hides these, the
		// history view must not.
		expect(
			(result.items as Array<{ status: string }>).some(
				(r) => r.status === "RESOLVED",
			),
		).toBe(true);
		expect(result.total).toBe(42);
		expect(result.page).toBe(1);
		expect(result.pageSize).toBe(25);
	});

	it("forwards default sinceDays=30 / status=all / source=all / page=1 / pageSize=25 when omitted", async () => {
		mockListIncidentHistory.mockResolvedValue({ items: [], total: 0 });

		const { handler, inputSchema } = await load();
		// The handler receives the POST-validation input; defaults are applied
		// by Zod, so parse an empty object to model the wire default.
		const parsed = inputSchema.parse({}) as Required<HandlerInput>;
		expect(parsed.sinceDays).toBe(30);
		expect(parsed.status).toBe("all");
		expect(parsed.source).toBe("all");
		expect(parsed.page).toBe(1);
		expect(parsed.pageSize).toBe(25);

		await handler({ input: parsed, context: adminCtx });
		expect(mockListIncidentHistory).toHaveBeenCalledWith({
			sinceDays: 30,
			status: "all",
			source: "all",
			page: 1,
			pageSize: 25,
		});
	});

	it("clamps the window at the input boundary: rejects sinceDays > 365 and < 1", async () => {
		const { inputSchema } = await load();
		expect(() => inputSchema.parse({ sinceDays: 366 })).toThrow();
		expect(() => inputSchema.parse({ sinceDays: 0 })).toThrow();
		// 365 (the retention ceiling) is the max accepted value.
		expect(
			(inputSchema.parse({ sinceDays: 365 }) as { sinceDays: number })
				.sinceDays,
		).toBe(365);
		expect(
			(inputSchema.parse({ sinceDays: 1 }) as { sinceDays: number })
				.sinceDays,
		).toBe(1);
	});

	it("rejects page < 1 at the input boundary", async () => {
		const { inputSchema } = await load();
		expect(() => inputSchema.parse({ page: 0 })).toThrow();
		expect(() => inputSchema.parse({ page: -1 })).toThrow();
		expect((inputSchema.parse({ page: 5 }) as { page: number }).page).toBe(
			5,
		);
	});

	it("accepts only pageSize ∈ {25,50,100}", async () => {
		const { inputSchema } = await load();
		for (const size of [25, 50, 100]) {
			expect(
				(inputSchema.parse({ pageSize: size }) as { pageSize: number })
					.pageSize,
			).toBe(size);
		}
		// Anything else is rejected at the boundary.
		expect(() => inputSchema.parse({ pageSize: 10 })).toThrow();
		expect(() => inputSchema.parse({ pageSize: 75 })).toThrow();
		expect(() => inputSchema.parse({ pageSize: 200 })).toThrow();
	});

	it("accepts the status + source enum values and rejects unknown ones", async () => {
		const { inputSchema } = await load();
		for (const status of ["all", "active", "hidden"]) {
			expect(
				(inputSchema.parse({ status }) as { status: string }).status,
			).toBe(status);
		}
		for (const source of [
			"all",
			"error-rate",
			"statuspage",
			"synthetic",
			"breaker",
			"alertmanager",
			"component",
		]) {
			expect(
				(inputSchema.parse({ source }) as { source: string }).source,
			).toBe(source);
		}
		expect(() => inputSchema.parse({ status: "bogus" })).toThrow();
		expect(() => inputSchema.parse({ source: "bogus" })).toThrow();
	});

	it("is registered behind the admin gate (not protectedProcedure)", async () => {
		await load();
		expect(usedProcedureNames).toContain("adminProcedure");
		expect(usedProcedureNames).not.toContain("protectedProcedure");
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ raw: vi.fn(), transaction: vi.fn() }));
vi.mock("../prisma/client", () => ({
	db: { $transaction: mocks.transaction },
}));

import { Prisma } from "../prisma/generated/client";
import { advisorToolResultStorage } from "../prisma/queries/advisor-tool-results";

const scope = {
	userId: "example-user",
	organizationId: "example-org",
	conversationId: "example-chat",
	beforeTurnGeneration: 2,
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.raw.mockResolvedValue([]);
	mocks.transaction.mockImplementation((fn) => fn({ $queryRaw: mocks.raw }));
});
describe("Advisor bounded SQL readers", () => {
	it.each(["list", "read"] as const)(
		"bounds %s pool, transaction, statements and locks",
		async (method) => {
			await advisorToolResultStorage[method]({
				...scope,
				id: "example-row",
			});
			expect(mocks.transaction.mock.calls[0][1]).toEqual({
				maxWait: 100,
				timeout: method === "list" ? 350 : 1300,
			});
			const [strings, ...values] = mocks.raw.mock.calls[0];
			const config = Prisma.sql(strings, ...values);
			expect(config.sql).toBe(
				"SELECT set_config('statement_timeout', ?, true), set_config('lock_timeout', '100ms', true), set_config('idle_in_transaction_session_timeout', ?, true)",
			);
			expect(config.values).toEqual(
				method === "list" ? ["200ms", "350ms"] : ["1000ms", "1300ms"],
			);
		},
	);
	it("projects only a bounded stored-text head and stored byte size for discovery", async () => {
		await advisorToolResultStorage.list(scope);
		const [strings, ...values] = mocks.raw.mock.calls[1];
		const query = Prisma.sql(strings, ...values);
		expect(query.sql).toContain(
			'ORDER BY r."createdAt" DESC, r."id" DESC LIMIT 30',
		);
		expect(query.sql).toContain("left(\"content\"->>'text', 200)");
		expect(query.sql).toContain('"sizeBytes"');
		expect(query.sql).not.toContain("char_length");
		expect(query.sql).not.toContain("regexp_replace");
		expect(query.values).toEqual([
			scope.conversationId,
			scope.userId,
			scope.organizationId,
			scope.beforeTurnGeneration,
		]);
	});
	it("uses a row predicate for pages and returns at most one row", async () => {
		const row = {
			toolName: "code_tree",
			content: { v: 1, text: "example" },
		};
		mocks.raw.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
		expect(
			await advisorToolResultStorage.read({
				...scope,
				id: "example-row",
			}),
		).toBe(row);
		const [strings, ...values] = mocks.raw.mock.calls[1];
		const query = Prisma.sql(strings, ...values);
		expect(query.sql).toContain('AND r."id"=? LIMIT 1');
		expect(query.values).toEqual([
			scope.conversationId,
			scope.userId,
			scope.organizationId,
			scope.beforeTurnGeneration,
			"example-row",
		]);
	});
});

it("uses one transaction for authorization and the listing or page", async () => {
	for (const kind of ["list", "page"] as const) {
		mocks.transaction.mockClear();
		await advisorToolResultStorage.readTransaction(kind, async (tx) => {
			return kind === "list"
				? advisorToolResultStorage.list(scope, tx)
				: advisorToolResultStorage.read(
						{ ...scope, id: "example-row" },
						tx,
					);
		});
		expect(mocks.transaction).toHaveBeenCalledTimes(1);
	}
});

it.each([
	["P2028", {}, false] as const,
	[
		"P2028",
		{ operation: "query", timeout: 20, timeTaken: 102 },
		true,
	] as const,
	...["P2010", "P2039"].flatMap((code) =>
		["57014", "55P03"].map(
			(pgCode) =>
				[
					code,
					{
						...(code === "P2039" ? { modelName: "User" } : {}),
						driverAdapterError: {
							name: "DriverAdapterError",
							cause: {
								code: pgCode,
								originalCode: pgCode,
								kind: "postgres",
								originalMessage:
									pgCode === "57014"
										? "canceling statement due to statement timeout"
										: "canceling statement due to lock timeout",
								message:
									pgCode === "57014"
										? "canceling statement due to statement timeout"
										: "canceling statement due to lock timeout",
								severity: "ERROR",
							},
						},
					},
					true,
				] as const,
		),
	),
])("normalizes observed time limit %s %j", async (code, meta, started) => {
	const error = new Prisma.PrismaClientKnownRequestError("example", {
		code: code as string,
		meta: meta as Record<string, unknown>,
		clientVersion: "7.10.1",
	});
	if (started) {
		mocks.raw.mockRejectedValueOnce(error);
	} else {
		mocks.transaction.mockRejectedValueOnce(error);
	}
	await expect(advisorToolResultStorage.list(scope)).rejects.toMatchObject({
		name: "AdvisorResultReadTimeoutError",
		code: "ADVISOR_RESULT_READ_TIMEOUT",
	});
});
it.each([
	new Error("statement timeout"),
	{
		code: "P2010",
		meta: { driverAdapterError: { cause: { code: "57014" } } },
	},
	new Prisma.PrismaClientKnownRequestError("example", {
		code: "P2002",
		clientVersion: "7.10.1",
		meta: { driverAdapterError: { cause: { code: "57014" } } },
	}),
	...["P2028", "P2010", "P2039", "P2002"].map(
		(code) =>
			new Prisma.PrismaClientKnownRequestError("example", {
				code,
				clientVersion: "7.10.1",
				meta: { driverAdapterError: { cause: { code: "23505" } } },
			}),
	),
])("preserves unrelated errors %j", async (error) => {
	mocks.raw.mockRejectedValueOnce(error);
	await expect(advisorToolResultStorage.list(scope)).rejects.toBe(error);
});

it.each(["list", "page"] as const)(
	"types the explicit %s callback deadline",
	async (kind) => {
		vi.useFakeTimers();
		try {
			const pending = expect(
				advisorToolResultStorage.readTransaction(
					kind,
					() => new Promise(() => {}),
				),
			).rejects.toMatchObject({
				name: "AdvisorResultReadTimeoutError",
				code: "ADVISOR_RESULT_READ_TIMEOUT",
			});
			await vi.advanceTimersByTimeAsync(kind === "list" ? 350 : 1300);
			await pending;
		} finally {
			vi.useRealTimers();
		}
	},
);
